// Original game/Pixi draws in native ANGLE, then one GPU composition pass into
// the D3D11 texture registered with native NVENC. No browser frame capture.
window.__createRawEncoder = ({width,height,fps}) => {
  const options=window.__nativeEncoderOptions,fs=require('node:fs'),path=require('node:path');
  const codec=require(options.windowsCodec),native=window.__native,gl=window.__nativeWebGLContext(native.app.view);
  window.__shutdownWindowsEncoder=()=>{codec.shutdown()};
  if(!gl?._isWebGL2)throw Error('Windows encoder requires native WebGL 2');
  if(native.foreground?.view.width===width)throw Error('Native Windows foreground layer composition is not implemented');
  window.__installNativeAudio(options);
  const nv12=process.env.REPLAY_WINDOWS_NV12==='1';if(nv12&&process.env.REPLAY_WINDOWS_ASYNC!=='1')throw Error('NV12 requires the async Windows encoder');
  const inplaceCompute=process.env.REPLAY_WINDOWS_COMPUTE_INPLACE==='1';
  const directTexture=process.env.REPLAY_WINDOWS_DIRECT_TEXTURE==='1';
  const fastCompose=process.env.REPLAY_WINDOWS_COMPOSE_FAST==='1';
  if(fastCompose&&!directTexture)throw Error('Fast Windows composition requires the direct game texture');
  let fastComposeFrames=0,guardedComposeFrames=0;
  const initialErrors=[];for(let error=gl.getError();error;error=gl.getError())initialErrors.push(error);
  const headerCanvas=document.createElement('canvas');headerCanvas.width=width;headerCanvas.height=Math.ceil(height*.065);
  const text=headerCanvas.getContext('2d');let headerLabel=null,index=0,segmentStart=0,opened=false,written=0;
  function saved(operation){
    const program=gl.getParameter(gl.CURRENT_PROGRAM),draw=gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),read=gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),vao=gl.getParameter(gl.VERTEX_ARRAY_BINDING),active=gl.getParameter(gl.ACTIVE_TEXTURE);
    gl.activeTexture(gl.TEXTURE0);const tex0=gl.getParameter(gl.TEXTURE_BINDING_2D);gl.activeTexture(gl.TEXTURE1);const tex1=gl.getParameter(gl.TEXTURE_BINDING_2D);
    try{return operation()}finally{gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,tex0);gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,tex1);gl.activeTexture(active);gl.useProgram(program);gl.bindVertexArray(vao);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,draw);gl.bindFramebuffer(gl.READ_FRAMEBUFFER,read)}
  }
  let program,vao,game,header;
  saved(()=>{
    function shader(type,source){const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s}
    program=gl.createProgram();gl.attachShader(program,shader(gl.VERTEX_SHADER,`#version 300 es
      void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0,1);}`));
    gl.attachShader(program,shader(gl.FRAGMENT_SHADER,nv12?`#version 300 es
      precision highp float;precision highp int;
      uniform sampler2D game;uniform sampler2D header;uniform ivec2 size;uniform int mode;out vec4 color;
      vec3 rgb(ivec2 p){vec3 c=texelFetch(game,ivec2(p.x,size.y-1-p.y),0).rgb;if(p.y<textureSize(header,0).y){vec4 h=texelFetch(header,p,0);c=mix(c,h.rgb,h.a);}return c;}
      void main(){ivec2 p=ivec2(gl_FragCoord.xy);if(mode==0){color=vec4((16.+219.*dot(rgb(p),vec3(.2126,.7152,.0722)))/255.,0,0,1);}
      else{p*=2;vec3 c=(rgb(p)+rgb(p+ivec2(1,0))+rgb(p+ivec2(0,1))+rgb(p+ivec2(1,1)))*.25;color=vec4((128.+224.*dot(c,vec3(-.114572,-.385428,.5)))/255.,(128.+224.*dot(c,vec3(.5,-.454153,-.045847)))/255.,0,1);}}`:`#version 300 es
      precision highp float;precision highp int;
      uniform sampler2D game;uniform sampler2D header;uniform ivec2 size;uniform int flip;out vec4 color;
      void main(){ivec2 p=ivec2(gl_FragCoord.xy);int top=flip==0?size.y-1-p.y:p.y;
        vec4 c=texelFetch(game,ivec2(p.x,flip==0?p.y:size.y-1-p.y),0);
        if(top<textureSize(header,0).y){vec4 h=texelFetch(header,ivec2(p.x,top),0);c.rgb=mix(c.rgb,h.rgb,h.a);}
        color=vec4(c.rgb,1);}`));
    gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);gl.uniform1i(gl.getUniformLocation(program,'game'),0);gl.uniform1i(gl.getUniformLocation(program,'header'),1);gl.uniform2i(gl.getUniformLocation(program,'size'),width,height);gl.uniform1i(gl.getUniformLocation(program,'flip'),process.env.REPLAY_WINDOWS_FLIP==='0'?0:1);
    vao=gl.createVertexArray();
    function texture(){const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);return t}
    game=texture();gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
    if(directTexture){
      const db=gl._drawingBuffer,binding=gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER,null);gl.copyTexSubImage2D(gl.TEXTURE_2D,0,0,0,0,0,width,height);
      gl._n.bindFramebuffer(gl.DRAW_FRAMEBUFFER,db.fbo);gl._n.framebufferTexture2D(gl.DRAW_FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,game._id,0);
      if(gl._n.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw Error('Direct Windows game texture framebuffer incomplete');
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,binding);
      db.allocate=()=>{throw Error('Native drawing buffer resized during direct texture export')};
    }
    header=texture();
    if(inplaceCompute)gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,width,headerCanvas.height,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
  });
  gl._ready();window.__nativeGLFlush?.();codec.initialize(gl._n._replayEGL(),width,height,fps);
  if(process.env.REPLAY_WINDOWS_COMPUTE==='1'){if(inplaceCompute)codec.configureCompute(headerCanvas.height,game._id,header._id);else codec.configureCompute(headerCanvas.height);}
  function open(){if(opened)return;codec.open(options.output);opened=true;segmentStart=index}
  async function flush(){if(!opened)return;const count=codec.close();opened=false;if(count!==index-segmentStart)throw Error('Native Windows segment frame count mismatch');written+=count;await window.__commitNativeSegment()}
  open();window.__nativeGLStart?.();
  return {
    qualityInputsOnly:!!options.qualityInputsOnly,
    compose({spans,font,roundCount}){
      const label=JSON.stringify(spans);
      if(fastCompose&&label===headerLabel){
        // Resolve preserves FBO/scissor state, and the native composition pass
        // saves/restores the game state itself. No JS texture bindings change.
        gl._drawingBuffer.resolve();gl._ready();window.__nativeGLFlush?.();
        codec.compose(program._id,vao._id,game._id,header._id);fastComposeFrames++;return;
      }
      guardedComposeFrames++;
      saved(()=>{
        gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,game);
        if(directTexture)gl._drawingBuffer.resolve();else{gl.bindFramebuffer(gl.READ_FRAMEBUFFER,null);gl.copyTexSubImage2D(gl.TEXTURE_2D,0,0,0,0,0,width,height);}
        gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,header);
        if(label!==headerLabel){
          text.clearRect(0,0,width,headerCanvas.height);text.fillStyle='#080808dd';text.fillRect(0,0,width,height*.065);text.fillStyle='#ff8a00';text.font=`bold ${Math.round(height*.035)}px ${font}`;text.fillText('REPLAY',width*.02,height*.045);text.fillStyle='white';text.font=`${Math.round(height*.027)}px ${font}`;text.fillText(`${spans[0]||''} VS ${spans[1]||''}${spans[2]?` · ROUND ${spans[2]} / ${roundCount}`:''}`,width*.15,height*.043);
          const premultiplied=gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL),flip=gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);if(inplaceCompute)gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,gl.RGBA,gl.UNSIGNED_BYTE,headerCanvas);else gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,headerCanvas);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,premultiplied);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,flip);headerLabel=label;
        }
        gl._ready();window.__nativeGLFlush?.();codec.compose(program._id,vao._id,game._id,header._id);
      });
    },
    capture:()=>null,
    qualitySample(draw,count){
      window.__nativeGLFlush?.();const bytes=codec.snapshot();fs.writeFileSync(path.join(options.qualitySamples,`frame-${String(count).padStart(6,'0')}.${nv12?'nv12':'bgra'}`),bytes,{flag:options.overwrite?'w':'wx'});
      if(!options.qualityInputsOnly){draw.drawImage(native.app.view,0,0,width,height);draw.drawImage(headerCanvas,0,0)}
    },
    beginRound:open,flushRound:flush,
    async write(){codec.encode(index===segmentStart||index%(fps*2)===0,index);index++},
    async finish(){await flush();if(written!==index)throw Error('Native Windows video frame count mismatch');window.__nativeEncoderResult={...codec.stats(),initialErrors,preset:'p1',tuning:'ultra-low-latency',quantizer:18,rateControl:'cqp',format:nv12?'nv12':'bgra',synchronous:process.env.REPLAY_WINDOWS_ASYNC!=='1',directTexture,fastComposition:{enabled:fastCompose,frames:fastComposeFrames,guardedFrames:guardedComposeFrames},antialiasSamples:gl._drawingBuffer.samples,gpuFence:process.env.REPLAY_WINDOWS_FENCE==='1'};codec.shutdown();window.__shutdownWindowsEncoder=null},
  };
};
