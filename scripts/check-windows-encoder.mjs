// Hardware integration check: ordered GL commands, pooled NV12 surfaces,
// incomplete GPU groups, snapshots, and independently decoded frame identities.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import ffmpeg from 'ffmpeg-static';

assert(process.platform==='win32'&&process.arch==='x64','Requires Windows x64 and the prepared native NVIDIA backend');
const root=fileURLToPath(new URL('../',import.meta.url));
const compute=process.env.REPLAY_WINDOWS_COMPUTE==='1';
const inplace=process.env.REPLAY_WINDOWS_COMPUTE_INPLACE==='1';
const [,batchArg,fenceArg,cavlcArg,surfacesArg,pendingArg]=process.argv.slice(2);
if(process.argv[2]!=='--case'){
  const d3d12=process.env.REPLAY_WINDOWS_D3D12==='1';
  const cases=[[1,1,0,16,4],[4,1,0,16,4],[13,1,0,16,4],[16,1,0,32,4],[4,d3d12?1:0,1,16,4],[4,1,1,16,12],[8,1,1,16,8],[16,1,1,16,1],[16,1,0,16,4],[8,1,0,16,12],[4,1,0,16,17]];
  if(d3d12)cases.push([4,0,1,16,4]);
  for(const [batch,fence,cavlc,surfaces,pending]of cases){
    const env={...process.env,REPLAY_WINDOWS_ASYNC:'1',REPLAY_WINDOWS_NV12:'1',REPLAY_WINDOWS_FENCE:String(fence),REPLAY_WINDOWS_CAVLC:String(cavlc),REPLAY_WINDOWS_GPU_BATCH:String(batch),REPLAY_WINDOWS_SURFACES:String(surfaces),REPLAY_WINDOWS_PENDING:String(pending),REPLAY_GL_ASYNC:'1',REPLAY_GL_SPECIALIZE:'1',REPLAY_GL_DEFER_FLUSH:'1'};
    const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--case',String(batch),String(fence),String(cavlc),String(surfaces),String(pending)],{env,encoding:'utf8',windowsHide:true,timeout:45000});
    if(pending>surfaces){assert.notEqual(child.status,0);assert.match(child.stderr,/pending frame count must be/);assert(!child.error);console.log('PASS: invalid pending count is rejected.');continue;}
    if(batch>surfaces-(pending-1)){assert.notEqual(child.status,0);assert.match(child.stderr,/must leave enough surfaces/);assert(!child.error,'Invalid configuration must fail before a timeout');console.log('PASS: unsafe pool/batch/pending combination is rejected before export.');continue;}
    if(d3d12&&!fence){assert.notEqual(child.status,0);assert.match(child.stderr,/D3D12 encoding requires REPLAY_WINDOWS_FENCE=1/);assert(!child.error);console.log('PASS: D3D12 without explicit GPU fences is rejected.');continue;}
    assert.equal(child.status,0,child.error?.message||child.stderr||child.stdout);
    console.log(child.stdout.trim());
  }
}else{
  // Native CRT getenv observes the environment inherited at process launch.
  assert.equal(process.env.REPLAY_WINDOWS_GPU_BATCH,batchArg,'Launch through the parent check to supply the native environment');
  const require=createRequire(import.meta.url);
  const {createCanvas}=await import('../.native-deps/node-webgl-windows/dist/index.js');
  const codec=require('../.native-deps/windows-gpu/windows-encoder.node');
  const size=256,canvas=createCanvas(size,size),gl=canvas.getContext('webgl2');assert(gl,'Native WebGL 2 context');
  const temp=await mkdtemp(path.join(tmpdir(),'replay-gpu-encoder-check-'));
  function shader(type,source){const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);assert(gl.getShaderParameter(s,gl.COMPILE_STATUS),gl.getShaderInfoLog(s));return s;}
  function program(fragment){const p=gl.createProgram();gl.attachShader(p,shader(gl.VERTEX_SHADER,'#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0,1);}'));gl.attachShader(p,shader(gl.FRAGMENT_SHADER,fragment));gl.linkProgram(p);assert(gl.getProgramParameter(p,gl.LINK_STATUS),gl.getProgramInfoLog(p));return p;}
  function texture(){const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,size,size,0,gl.RGBA,gl.UNSIGNED_BYTE,compute?new Uint8Array(size*size*4):null);return t;}
  const game=texture(),header=texture(),fbo=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,game,0);assert.equal(gl.checkFramebufferStatus(gl.FRAMEBUFFER),gl.FRAMEBUFFER_COMPLETE);
  const pattern=program(`#version 300 es
    precision highp float;precision highp int;uniform int index;out vec4 color;
    void main(){ivec2 p=ivec2(gl_FragCoord.xy);int y=p.y<32?50:p.y>=224?150:((index>>(p.x/32))&1)==1?220:32;color=vec4(${compute?'vec3(float(y)/255.)':'vec3(float(y)/255.,0,0)'},1);}`);
  const convert=program(`#version 300 es
    precision highp float;precision highp int;uniform sampler2D game;uniform int mode;out vec4 color;
    void main(){color=mode==0?vec4(texelFetch(game,ivec2(gl_FragCoord.xy),0).r,0,0,1):vec4(128./255.,128./255.,0,1);}`);
  gl.useProgram(convert);gl.uniform1i(gl.getUniformLocation(convert,'game'),0);
  const indexUniform=gl.getUniformLocation(pattern,'index'),vao=gl.createVertexArray();gl.bindVertexArray(vao);
  function expected(gray,row,frame){
    if(!compute)return[gray,128,128];let c=[gray/255,gray/255,gray/255];
    if(row<17){const header=frame<17?[1,0,0]:[0,0,1];c=c.map((v,i)=>v*(1-128/255)+header[i]*128/255);}
    return[Math.round(16+219*(c[0]*.2126+c[1]*.7152+c[2]*.0722)),Math.round(128+224*(-.114572*c[0]-.385428*c[1]+.5*c[2])),Math.round(128+224*(.5*c[0]-.454153*c[1]-.045847*c[2]))];
  }
  try{
    let initial;if(inplace){gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.clearColor(.125,.25,.5,.75);gl.clear(gl.COLOR_BUFFER_BIT);initial=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,initial);}
    codec.initialize(gl._n._replayEGL(),size,size,60);
    if(compute){assert.throws(()=>codec.configureCompute(0),/Invalid compute header height/);if(inplace)codec.configureCompute(size,game._id,header._id);else codec.configureCompute(size);assert.throws(()=>codec.configureCompute(size),/configured once/);}
    if(inplace){const after=new Uint8Array(4);gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,after);assert.deepEqual(after,initial,'Rebinding the native game texture preserves its existing contents');}
    assert.throws(()=>codec.initialize(gl._n._replayEGL(),size,size,60),/already initialized/,'Repeated initialization must not replace a live encoder');
    // Use the same owned GL command transport as the actual replay backend.
    Object.assign(globalThis,{window:globalThis,require,__windowsNativeGLBatch:true,__glBatchModule:path.join(root,'.native-deps/windows-gpu/windows-encoder.node'),__glCommandSchema:JSON.parse(await readFile(path.join(root,'src/experimental/gl-commands.json'),'utf8'))});
    for(const file of ['gl-writers.generated.js','gl-batch.js'])vm.runInThisContext(await readFile(path.join(root,'src/experimental',file),'utf8'),{filename:file});
    __installGLBatch(gl);__nativeGLStart();
    codec.open(path.join(temp,'empty.h264'));assert.equal(codec.close(),0,'An empty frame window must close without hanging or producing frames');
    const files=[];let index=0;
    for(const [segment,count]of [17,80].entries()){
      const file=path.join(temp,`segment-${segment}.h264`);files.push(file);codec.open(file);
      if(compute){const bytes=new Uint8Array(size*17*4);for(let i=0;i<bytes.length;i+=4){bytes[i+(segment?2:0)]=255;bytes[i+3]=128;}gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,header);gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,size,17,gl.RGBA,gl.UNSIGNED_BYTE,bytes);}
      for(let frame=0;frame<count;frame++,index++){
        gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.viewport(0,0,size,size);gl.disable(gl.BLEND);gl.disable(gl.SCISSOR_TEST);gl.useProgram(pattern);gl.bindVertexArray(vao);gl.uniform1i(indexUniform,index);gl.drawArrays(gl.TRIANGLES,0,3);__nativeGLFlush();
        codec.compose(convert._id,vao._id,game._id,header._id);
        if(index===6||index===20||index===96){
          const nv12=codec.snapshot();assert.equal(nv12.length,size*size*1.5);
          for(let bit=0;bit<8;bit++)assert(Math.abs(nv12[128*size+bit*32+16]-expected((index>>bit)&1?220:32,128,index)[0])<=1,'Snapshot frame identity');
          assert(Math.abs(nv12[16*size+128]-expected(compute?150:50,16,index)[0])<=1,'Snapshot top row/header');assert(Math.abs(nv12[240*size+128]-expected(compute?50:150,240,index)[0])<=1,'Snapshot bottom row');
          assert(nv12.subarray(size*size+(compute?size*9:0)).every(value=>value===128),'Snapshot neutral chroma outside header');
          if(compute)for(let channel=1;channel<=2;channel++)assert(Math.abs(nv12[size*size+size+128+channel-1]-expected(150,2,index)[channel])<=1,'Snapshot header chroma');
        }
        codec.encode(frame===0,index);
      }
      assert.equal(codec.close(),count,'Segment frame count, including incomplete GPU groups');
    }
    const stats=codec.stats();assert.equal(stats.frames,97);assert.equal(stats.gpuBatch,Number(batchArg));assert.equal(stats.pendingLimit,Number(pendingArg));assert.equal(stats.surfaces,Number(surfacesArg));assert.equal(stats.d3d12,process.env.REPLAY_WINDOWS_D3D12==='1'?1:0);assert.equal(stats.computeConversion,compute?1:0);assert.equal(stats.computeInPlace,inplace?1:0);if(compute){assert.equal(stats.computeFrames,97);assert.equal(stats.computeSubmissions,97);}codec.shutdown();
    const encoded=Buffer.concat(await Promise.all(files.map(file=>readFile(file))));
    const decoded=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-f','h264','-i','pipe:0','-threads','1','-pix_fmt','yuv420p','-f','rawvideo','pipe:1'],{input:encoded,maxBuffer:16*1024*1024,windowsHide:true});
    assert.equal(decoded.status,0,decoded.stderr.toString());const frameBytes=size*size*1.5;assert.equal(decoded.stdout.length,97*frameBytes,'Every encoded frame decodes');
    for(let frame=0;frame<97;frame++){
      const offset=frame*frameBytes;
      for(let bit=0;bit<8;bit++)assert(Math.abs(decoded.stdout[offset+128*size+bit*32+16]-expected((frame>>bit)&1?220:32,128,frame)[0])<=3,`Decoded frame ${frame}, identity bit ${bit}`);
      assert(Math.abs(decoded.stdout[offset+16*size+128]-expected(compute?150:50,16,frame)[0])<=3,`Decoded frame ${frame} top/header`);assert(Math.abs(decoded.stdout[offset+240*size+128]-expected(compute?50:150,240,frame)[0])<=3,`Decoded frame ${frame} bottom`);
    }
    console.log(`PASS: batch ${batchArg}/${surfacesArg} surfaces, pending ${pendingArg}, fence ${fenceArg}, CAVLC ${cavlcArg}: all 97 decoded frame identities, orientation, snapshots, texture reuse and partial-group segment restarts.`);
  }finally{
    codec.shutdown();
    assert.equal(path.dirname(path.resolve(temp)),path.resolve(tmpdir()));assert(path.basename(temp).startsWith('replay-gpu-encoder-check-'));
    await rm(temp,{recursive:true,force:true});
  }
}
