// Native ANGLE -> shared NV12 IOSurfaces -> x264 worker threads. No browser
// compositor and no full-frame readPixels in the export path.
window.__createRawEncoder = ({width,height,fps}) => {
  const options=window.__nativeEncoderOptions;
  const threads=Number(process.env.REPLAY_X264_THREADS||4);
  const quantizer=process.env.REPLAY_X264_QP===undefined?null:Number(process.env.REPLAY_X264_QP);
  if(quantizer!==null&&(!Number.isInteger(quantizer)||quantizer<0||quantizer>51))throw Error('REPLAY_X264_QP must be an integer between 0 and 51');
  const gpuBatch=Number(process.env.REPLAY_GPU_BATCH||1);
  const surfaceCount=Number(process.env.REPLAY_SURFACES||32);
  const directTexture=process.env.REPLAY_DIRECT_TEXTURE==='1';
  const implicitResolveRequested=process.env.REPLAY_IMPLICIT_RESOLVE==='1';
  const packedNV12=process.env.REPLAY_PACKED_NV12==='1'&&width%4===0;
  if(packedNV12&&process.env.REPLAY_CENTRAL_ENCODER)throw Error('Packed NV12 requires the local native encoder');
  const codecWorkerQos=process.env.REPLAY_CODEC_WORKER_QOS||null;
  if(codecWorkerQos&&!['interactive','initiated'].includes(codecWorkerQos))throw Error('REPLAY_CODEC_WORKER_QOS must be interactive or initiated');
  if(implicitResolveRequested&&!directTexture)throw Error('Implicit resolve requires the direct game texture');
  if(!Number.isInteger(threads)||threads<1||threads>32)throw Error('REPLAY_X264_THREADS must be an integer between 1 and 32');
  if(!Number.isInteger(gpuBatch)||gpuBatch<1||gpuBatch>16)throw Error('REPLAY_GPU_BATCH must be an integer between 1 and 16');
  if(!Number.isInteger(surfaceCount)||surfaceCount<16||surfaceCount>96)throw Error('REPLAY_SURFACES must be an integer between 16 and 96');
  const bridge=require(options.directory+'/angle-surface.node');
  const encoder=process.env.REPLAY_CENTRAL_ENCODER?window.__createCentralEncoder(options):require(options.directory+'/x264-surface-encoder.node');
  const fs=require('node:fs');
  window.__installNativeAudio(options);
  const planes=options.qualitySamples?require(options.directory+'/surface-planes.node'):null;
  const native=window.__native;
  if(native.foreground?.view.width===width)throw Error('Native encoder foreground composition is not implemented');
  const gl=window.__nativeWebGLContext(native.app.view);
  if(!gl?._isWebGL2)throw Error('Native encoder requires native WebGL 2');
  const implicitResolve=implicitResolveRequested&&!!gl._drawingBuffer.msFbo&&gl._drawingBuffer.samples>0;
  const initialErrors=[];for(let error=gl.getError();error;error=gl.getError())initialErrors.push(error);
  function saved(operation){
    const program=gl.getParameter(gl.CURRENT_PROGRAM),draw=gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),read=gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),vao=gl.getParameter(gl.VERTEX_ARRAY_BINDING),active=gl.getParameter(gl.ACTIVE_TEXTURE),viewport=gl.getParameter(gl.VIEWPORT),mask=gl.getParameter(gl.COLOR_WRITEMASK);
    const capabilities=[gl.BLEND,gl.DEPTH_TEST,gl.STENCIL_TEST,gl.SCISSOR_TEST,gl.CULL_FACE];
    const enabled=capabilities.map(cap=>gl.isEnabled(cap));
    gl.activeTexture(gl.TEXTURE0);const tex0=gl.getParameter(gl.TEXTURE_BINDING_2D);
    gl.activeTexture(gl.TEXTURE1);const tex1=gl.getParameter(gl.TEXTURE_BINDING_2D);
    try{return operation()}
    finally{
      gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,tex0);gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,tex1);gl.activeTexture(active);
      gl.useProgram(program);gl.bindVertexArray(vao);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,draw);gl.bindFramebuffer(gl.READ_FRAMEBUFFER,read);gl.viewport(...viewport);gl.colorMask(...mask);
      capabilities.forEach((cap,i)=>enabled[i]?gl.enable(cap):gl.disable(cap));
    }
  }
  bridge.load(options.angle);
  if(process.env.REPLAY_METAL_PROBE==='1'){window.__nativeGLFlush?.();bridge.barrier();window.__nativeMetalProbe=bridge.probeMetalInterop();}
  const pool=[],free=[],held=new Map(),waiters=[],batch=[];
  let failure=null,index=0,current=null,segmentStart=0,opened=false,written=0;
  const metrics={composeMs:0,waitMs:0,finishMs:0,segments:[],gpuBatch,surfaceCount,directTexture,implicitResolve,codecWorkerQos,packedNV12};
  function effectsTrace(){
    if(process.env.REPLAY_TRACE_EFFECTS!=='1')return undefined;
    const ids=new Map(),hash=require('node:crypto').createHash;
    return __offlineSfx.map(({buffer,...effect})=>{if(!ids.has(buffer)){const data=buffer.getChannelData(0);ids.set(buffer,hash('sha256').update(Buffer.from(data.buffer,data.byteOffset,data.byteLength)).digest('hex'))}return{...effect,source:ids.get(buffer)}});
  }
  let game,header,program,mode,vao;
  const headerCanvas=document.createElement('canvas');headerCanvas.width=width;headerCanvas.height=Math.ceil(height*.065);
  const text=headerCanvas.getContext('2d',{willReadFrequently:true});let headerLabel=null;
  saved(()=>{
    function shader(type,source){const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s}
    program=gl.createProgram();
    gl.attachShader(program,shader(gl.VERTEX_SHADER,`#version 300 es
    void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0,1);}`));
    gl.attachShader(program,shader(gl.FRAGMENT_SHADER,packedNV12?`#version 300 es
    precision highp float;precision highp int;
    uniform sampler2D game;uniform sampler2D header;uniform ivec2 size;
    layout(location=0)out vec4 luma;layout(location=1)out vec4 chroma;
    vec3 rgb(ivec2 p){
      vec4 c=texelFetch(game,ivec2(p.x,size.y-1-p.y),0);
      if(p.y<textureSize(header,0).y){vec4 h=texelFetch(header,p,0);c.rgb=mix(c.rgb,h.rgb,h.a);}
      return c.rgb;
    }
    float y(ivec2 p){return (16.+219.*dot(rgb(p),vec3(.2126,.7152,.0722)))/255.;}
    vec2 uv(ivec2 p){
      vec3 c=(rgb(p)+rgb(p+ivec2(1,0))+rgb(p+ivec2(0,1))+rgb(p+ivec2(1,1)))*.25;
      return vec2((128.+224.*dot(c,vec3(-.114572,-.385428,.5)))/255.,(128.+224.*dot(c,vec3(.5,-.454153,-.045847)))/255.);
    }
    void main(){
      ivec2 q=ivec2(gl_FragCoord.xy),p=ivec2(q.x*4,q.y);
      luma=vec4(y(p),y(p+ivec2(1,0)),y(p+ivec2(2,0)),y(p+ivec2(3,0)));
      if(q.y<size.y/2){p=ivec2(q.x*4,q.y*2);chroma=vec4(uv(p),uv(p+ivec2(2,0)));}
      else chroma=vec4(0);
    }`:`#version 300 es
    precision highp float;precision highp int;
    uniform sampler2D game;uniform sampler2D header;uniform ivec2 size;uniform int mode;out vec4 color;
    vec3 rgb(ivec2 p){
      vec4 c=texelFetch(game,ivec2(p.x,size.y-1-p.y),0);
      if(p.y<textureSize(header,0).y){vec4 h=texelFetch(header,p,0);c.rgb=mix(c.rgb,h.rgb,h.a);}
      return c.rgb;
    }
    void main(){
      ivec2 p=ivec2(gl_FragCoord.xy);
      if(mode==0){color=vec4((16.+219.*dot(rgb(p),vec3(.2126,.7152,.0722)))/255.,0,0,1);}
      else {p*=2;vec3 c=(rgb(p)+rgb(p+ivec2(1,0))+rgb(p+ivec2(0,1))+rgb(p+ivec2(1,1)))*.25;
      color=vec4((128.+224.*dot(c,vec3(-.114572,-.385428,.5)))/255.,(128.+224.*dot(c,vec3(.5,-.454153,-.045847)))/255.,0,1);}
    }`));
    gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);gl.uniform1i(gl.getUniformLocation(program,'game'),0);gl.uniform1i(gl.getUniformLocation(program,'header'),1);gl.uniform2i(gl.getUniformLocation(program,'size'),width,height);mode=gl.getUniformLocation(program,'mode');
    vao=gl.createVertexArray();
    function texture(){const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);return t}
    game=texture();gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
    if(directTexture){
      const binding=gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),db=gl._drawingBuffer;
      if(!db.msFbo){
        // Without a multisample buffer, the current image is in the attachment
        // we are about to replace.
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER,null);
        gl.copyTexSubImage2D(gl.TEXTURE_2D,0,0,0,0,0,width,height);
      }
      gl._n.bindFramebuffer(gl.DRAW_FRAMEBUFFER,db.fbo);gl._n.framebufferTexture2D(gl.DRAW_FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,game._id,0);
      if(gl._n.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw Error('Direct game texture framebuffer is incomplete');
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,binding);
      if(implicitResolve){
        // Seed the replacement with the previous resolved canvas, preserving
        // the menu/game transition before the first exported frame.
        db.resolve();window.__nativeGLFlush?.();bridge.barrier();
        metrics.implicitResolveStorage=bridge.configureImplicitResolve(db.fbo,game._id,db.samples,width,height,db.depthStencil,db.stencil?gl.DEPTH24_STENCIL8:gl.DEPTH_COMPONENT24,db.stencil?gl.DEPTH_STENCIL_ATTACHMENT:gl.DEPTH_ATTACHMENT);
        const oldFramebuffer=db.msFbo,oldColor=db.msColor,oldDepth=db.msDepthStencil;db.msFbo=db.msColor=db.msDepthStencil=0;
        gl._n.bindFramebuffer(gl.FRAMEBUFFER,db.fbo);
        const path=require('node:path');const {clearFramebufferContents}=require(path.join(path.dirname(window.__nativeWebGLModule),'webgl/drawing-buffer.js'));
        clearFramebufferContents(gl._n,true,gl.DEPTH_BUFFER_BIT|gl.STENCIL_BUFFER_BIT);
        gl._n.deleteFramebuffers(1,new Uint32Array([oldFramebuffer]));
        const oldBuffers=[oldColor,oldDepth].filter(Boolean);gl._n.deleteRenderbuffers(oldBuffers.length,new Uint32Array(oldBuffers));
      }
    }
    header=texture();
    for(let i=0;i<surfaceCount;i++){
      const y=gl.createFramebuffer(),uv=packedNV12?y:gl.createFramebuffer();
      window.__nativeGLFlush?.();const surface=bridge.create(width,height,y._id,uv._id,packedNV12);pool.push({...surface,y,uv});free.push(pool[i]);
    }
  });
  const complete=(id,status)=>{
    const entry=held.get(id);if(!entry){failure=Error('Unknown encoder completion '+id);return}
    held.delete(id);free.push(entry);if(status)failure=encoder.failure||Error('Native encoding failed '+status);
    const waiter=waiters.shift();if(waiter)failure?waiter.reject(failure):waiter.resolve();
  };
  function open(){if(opened)return;encoder.open(width,height,fps,12000000,options.output,complete);opened=true;segmentStart=index;}
  function submitBatch(){if(!batch.length)return;window.__nativeGLFlush?.();const result=bridge.fence(batch.length),fences=batch.length===1?[result]:result;for(let i=0;i<batch.length;i++){const frame=batch[i];encoder.encode(frame.surface.handle,frame.index,frame.key,fences[i]);}batch.length=0;}
  async function flush(){if(!opened)return;submitBatch();const stats=encoder.stats();const frames=await encoder.close();metrics.segments.push(encoder.shared?encoder.stats():stats);opened=false;if(frames!==index-segmentStart)throw Error('Native encoder segment frame count mismatch');written+=frames;await window.__commitNativeSegment();}
  open();
  window.__nativeGLStart?.();
  return {
    qualityInputsOnly:!!options.qualityInputsOnly,
    async beforeFrame(){if(failure)throw failure;const t=__timeline.wallNow();if(!free.length)await new Promise((resolve,reject)=>waiters.push({resolve,reject}));metrics.waitMs+=__timeline.wallNow()-t;current=free.pop()},
    compose({label,font}){
      if(implicitResolve&&(gl._drawingBuffer.msFbo||gl._drawingBuffer.width!==width||gl._drawingBuffer.height!==height))throw Error('Implicit export framebuffer was resized or replaced');
      const start=__timeline.wallNow();
      saved(()=>{
        gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,game);
        if(directTexture)gl._drawingBuffer.resolve();
        else{gl.bindFramebuffer(gl.READ_FRAMEBUFFER,null);gl.copyTexSubImage2D(gl.TEXTURE_2D,0,0,0,0,0,width,height);}
        gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,header);
        if(headerLabel!==label){
          text.clearRect(0,0,width,headerCanvas.height);text.fillStyle='#080808dd';text.fillRect(0,0,width,height*.065);text.fillStyle='#ff8a00';text.font=`bold ${Math.round(height*.035)}px ${font}`;text.fillText('REPLAY',width*.02,height*.045);text.fillStyle='white';text.font=`${Math.round(height*.027)}px ${font}`;text.fillText(label,width*.15,height*.043);
          const premultiplied=gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL),flip=gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL);
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,headerCanvas);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,premultiplied);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,flip);headerLabel=label;
        }
        gl.useProgram(program);gl.bindVertexArray(vao);for(const cap of [gl.BLEND,gl.DEPTH_TEST,gl.STENCIL_TEST,gl.SCISSOR_TEST,gl.CULL_FACE])gl.disable(cap);gl.colorMask(true,true,true,true);
        if(packedNV12){gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,current.y);gl.viewport(0,0,width/4,height);gl.drawArrays(gl.TRIANGLES,0,3);}
        else{
          gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,current.y);gl.viewport(0,0,width,height);gl.uniform1i(mode,0);gl.drawArrays(gl.TRIANGLES,0,3);
          gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,current.uv);gl.viewport(0,0,width/2,height/2);gl.uniform1i(mode,1);gl.drawArrays(gl.TRIANGLES,0,3);
        }
        if(gpuBatch===1){window.__nativeGLFlush?.();current.fence=bridge.fence();}
      });
      metrics.composeMs+=__timeline.wallNow()-start;
    },
    capture:()=>null,
    qualitySample(draw,count){
      if(!planes)return;
      if(Number(process.env.REPLAY_SCENE_SNAPSHOT)===count){
        const describe=node=>{
          const values={};for(const key of Object.keys(node)){const value=node[key];if(typeof value==='number'||typeof value==='boolean'||typeof value==='string')values[key]=value;else if(ArrayBuffer.isView(value))values[key]={type:value.constructor.name,length:value.length,values:Array.from(value).slice(0,32)};}
          return{type:node.constructor.name,name:node.name,position:[node.x,node.y],scale:[node.scale?.x,node.scale?.y],values,children:node.children?.map(describe)};
        };
        fs.writeFileSync(require('node:path').join(options.qualitySamples,`scene-${String(count).padStart(6,'0')}.json`),JSON.stringify(describe(native.app.stage),null,2));
      }
      gl.finish();
      if(!options.qualityInputsOnly){draw.drawImage(native.app.view,0,0,width,height);draw.drawImage(headerCanvas,0,0);}
      const data=planes.lock(current.handle),chunks=[];
      try{
        for(let plane=0;plane<2;plane++)for(let row=0;row<(plane?height/2:height);row++)chunks.push(data[plane].data.subarray(row*data[plane].stride,row*data[plane].stride+width));
        fs.writeFileSync(require('node:path').join(options.qualitySamples,`frame-${String(count).padStart(6,'0')}.nv12`),Buffer.concat(chunks),{flag:options.overwrite?'w':'wx'});
      }finally{planes.unlock(current.handle)}
      const error=gl.getError();if(error)throw Error('Native GL error during quality sample: '+error);
    },
    beginRound:open,
    flushRound:flush,
    async write(){if(failure)throw failure;held.set(index,current);const key=index===segmentStart||index%(fps*2)===0;if(gpuBatch===1)encoder.encode(current.handle,index,key,current.fence);else{batch.push({surface:current,index,key});if(batch.length>=gpuBatch)submitBatch();}index++;current=null},
    async finish(){const t=__timeline.wallNow();await flush();encoder.shutdown?.();gl._ready();window.__nativeGLFlush?.();bridge.close();metrics.finishMs=__timeline.wallNow()-t;if(written!==index)throw Error('Native encoder frame count mismatch');if(failure)throw failure;window.__nativeEncoderResult={frames:written,metrics,initialErrors,effectsTrace:effectsTrace(),preset:'ultrafast',crf:quantizer===null?18:null,quantizer,rateControl:quantizer===null?'crf':'cqp',threads,slicedThreads:process.env.REPLAY_X264_SLICED==='1',shared:!!encoder.shared,intraOnly:process.env.REPLAY_X264_INTRA==='1'}},
  };
};
