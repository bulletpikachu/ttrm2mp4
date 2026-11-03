// Pack limited-range BT.709 NV12 on the GPU before reading pixels back to Node.
// This transfers 1.5 rather than 4 bytes per pixel. It is experimental until
// color and compression quality are checked against the existing export.
window.__createNV12Packer = (width,height,{slots=0,copyMethod='pbo'}={}) => {
  if(copyMethod==='worker')return window.__createNV12Workers(width,height,{slots});
  if(height%8)throw Error('Experimental NV12 packing requires height divisible by eight.');
  const videoCopy=copyMethod==='videoframe',channels=videoCopy?3:4,rows=height*3/(2*channels);
  const canvas=new OffscreenCanvas(width,rows);
  const gl=canvas.getContext('webgl2',{alpha:!videoCopy,premultipliedAlpha:videoCopy,antialias:false,depth:false,stencil:false,preserveDrawingBuffer:!videoCopy});
  if(!gl)throw Error('WebGL2 required for NV12 packing');
  function shader(type,source){const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s}
  const program=gl.createProgram();
  gl.attachShader(program,shader(gl.VERTEX_SHADER,`#version 300 es
  void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0,1);}`));
  gl.attachShader(program,shader(gl.FRAGMENT_SHADER,`#version 300 es
  precision highp float;precision highp int;
  uniform sampler2D image;uniform ivec2 size;out vec4 packed;
  vec3 rgb(ivec2 p){return texelFetch(image,p,0).rgb;}
  float byteValue(int index){
    int pixels=size.x*size.y;
    if(index<pixels){ivec2 p=ivec2(index%size.x,index/size.x);return (16.+219.*dot(rgb(p),vec3(.2126,.7152,.0722)))/255.;}
    int i=index-pixels;ivec2 p=ivec2(((i%size.x)/2)*2,(i/size.x)*2);
    vec3 c=(rgb(p)+rgb(p+ivec2(1,0))+rgb(p+ivec2(0,1))+rgb(p+ivec2(1,1)))*.25;
    float v=i%2==0?dot(c,vec3(-.114572,-.385428,.5)):dot(c,vec3(.5,-.454153,-.045847));
    return (128.+224.*v)/255.;
  }
  void main(){int row=${videoCopy?`${rows}-1-int(gl_FragCoord.y)`:'int(gl_FragCoord.y)'};int i=(row*size.x+int(gl_FragCoord.x))*${channels};packed=vec4(byteValue(i),byteValue(i+1),byteValue(i+2),${videoCopy?'1.':'byteValue(i+3)'});}`));
  gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);gl.uniform2i(gl.getUniformLocation(program,'size'),width,height);
  const texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL,gl.NONE);
  const bytes=new Uint8Array(width*height*3/2);
  function draw(source){gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,source);gl.drawArrays(gl.TRIANGLES,0,3)}
  if(slots&&videoCopy){
    const free=Array.from({length:slots},()=>({bytes:new Uint8Array(width*rows*4),ready:false,error:null,meta:null})),pending=[];
    let checked=false;
    return {
      get freeCount(){return free.length},get pendingCount(){return pending.length},peek:()=>pending[0],
      submit(source,meta){
        const slot=free.pop();if(!slot)throw Error('GPU copy ring is full');draw(source);slot.meta=meta;slot.ready=false;slot.error=null;
        // RGB carries packed bytes; opaque alpha prevents premultiplication
        // from rounding those bytes. Verify the first actual GPU copy exactly.
        let reference;if(!checked){reference=new Uint8Array(slot.bytes.length);gl.readPixels(0,0,width,rows,gl.RGBA,gl.UNSIGNED_BYTE,reference);checked=true;}
        const frame=new VideoFrame(canvas,{timestamp:meta.index,alpha:'discard'});
        if(!['RGBA','RGBX','BGRA','BGRX'].includes(frame.format)){frame.close();throw Error('Unexpected packed-copy format '+frame.format)}
        meta.bgr=frame.format.startsWith('BG');meta.sourceFormat=frame.format;
        frame.copyTo(slot.bytes).then(layout=>{
          if(layout.length!==1||layout[0].offset!==0||layout[0].stride!==width*4)throw Error('Unexpected GPU-copy layout');
          if(reference)for(let y=0;y<rows;y++)for(let x=0;x<width*4;x++){const channel=x%4,sourceX=meta.bgr&&channel!==1&&channel!==3?x+(channel===0?2:-2):x;if(slot.bytes[y*width*4+x]!==reference[(rows-1-y)*width*4+sourceX])throw Error('GPU copy changed packed bytes at '+(y*width*4+x));}
          slot.ready=true;
        }).catch(error=>slot.error=error).finally(()=>frame.close());pending.push(slot);return slot;
      },
      ready(slot){if(slot.error)throw slot.error;return slot.ready},
      read(slot){if(slot!==pending[0]||!slot.ready)throw Error('GPU copies must remain ordered');return slot.bytes},
      release(slot){if(pending.shift()!==slot)throw Error('GPU copy released out of order');slot.meta=null;free.push(slot)},
      close(){if(pending.length)throw Error('Cannot close pending GPU copies');gl.deleteTexture(texture);gl.deleteProgram(program)},
    };
  }
  if(slots){
    const free=[],pending=[];
    for(let i=0;i<slots;i++){const buffer=gl.createBuffer();gl.bindBuffer(gl.PIXEL_PACK_BUFFER,buffer);gl.bufferData(gl.PIXEL_PACK_BUFFER,bytes.length,gl.STREAM_READ);free.push({buffer,bytes:new Uint8Array(bytes.length),fence:null,meta:null})}
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER,null);
    return {
      get freeCount(){return free.length},get pendingCount(){return pending.length},peek:()=>pending[0],
      submit(source,meta){const slot=free.pop();if(!slot)throw Error('GPU pixel-pack ring is full');draw(source);gl.bindBuffer(gl.PIXEL_PACK_BUFFER,slot.buffer);gl.readPixels(0,0,width,height*3/8,gl.RGBA,gl.UNSIGNED_BYTE,0);gl.bindBuffer(gl.PIXEL_PACK_BUFFER,null);slot.fence=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);if(!slot.fence)throw Error('Cannot create GPU readback fence');slot.meta=meta;pending.push(slot);gl.flush();return slot},
      ready(slot){const status=gl.clientWaitSync(slot.fence,0,0);if(status===gl.WAIT_FAILED)throw Error('GPU readback fence failed');return status===gl.ALREADY_SIGNALED||status===gl.CONDITION_SATISFIED},
      read(slot){if(slot!==pending[0])throw Error('GPU readbacks must remain ordered');gl.bindBuffer(gl.PIXEL_PACK_BUFFER,slot.buffer);gl.getBufferSubData(gl.PIXEL_PACK_BUFFER,0,slot.bytes);gl.bindBuffer(gl.PIXEL_PACK_BUFFER,null);const error=gl.getError();if(error)throw Error('GPU readback failed: '+error);return slot.bytes},
      release(slot){if(pending.shift()!==slot)throw Error('GPU slot released out of order');gl.deleteSync(slot.fence);slot.fence=null;slot.meta=null;free.push(slot)},
      close(){if(pending.length)throw Error('Cannot close pending GPU readbacks');for(const slot of free)gl.deleteBuffer(slot.buffer);gl.deleteTexture(texture);gl.deleteProgram(program);},
    };
  }
  return (source,destination=bytes)=>{
    draw(source);
    gl.readPixels(0,0,width,height*3/8,gl.RGBA,gl.UNSIGNED_BYTE,destination);
    return {data:destination};
  };
};
