// Compare one-dispatch HLSL output with the actual current two-pass GLES shader.
// Compare raw NV12 before examining lossy H.264; no replay-quality gate changes.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import {createCanvas} from '../.native-deps/node-webgl-windows/dist/index.js';
const require=createRequire(import.meta.url),native=require('../.native-deps/windows-gpu/windows-d3d12-probe.node');
const current=await readFile(new URL('../src/experimental/windows-encoder.js',import.meta.url),'utf8');
const marker='gl.FRAGMENT_SHADER,nv12?`',start=current.indexOf(marker),end=current.indexOf('`:`#version',start);
assert(start>=0&&end>start);const fragment=current.slice(start+marker.length,end);
const canvas=createCanvas(256,256),gl=canvas.getContext('webgl2');assert(gl);
function shader(type,source){const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);assert(gl.getShaderParameter(s,gl.COMPILE_STATUS),gl.getShaderInfoLog(s));return s;}
const program=gl.createProgram();gl.attachShader(program,shader(gl.VERTEX_SHADER,'#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0,1);}'));gl.attachShader(program,shader(gl.FRAGMENT_SHADER,fragment));gl.linkProgram(program);assert(gl.getProgramParameter(program,gl.LINK_STATUS),gl.getProgramInfoLog(program));
gl.bindVertexArray(gl.createVertexArray());gl.useProgram(program);gl.uniform1i(gl.getUniformLocation(program,'game'),0);gl.uniform1i(gl.getUniformLocation(program,'header'),1);
function texture(unit,width,height,bytes,components=4){
  gl.activeTexture(gl.TEXTURE0+unit);const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D,0,components===4?gl.RGBA8:components===2?gl.RG8:gl.R8,width,height,0,components===4?gl.RGBA:components===2?gl.RG:gl.RED,gl.UNSIGNED_BYTE,bytes);return t;
}
const reports=[];
for(const sharedContext of [false,true])for(const [width,height,headerHeight]of [[256,256,17],[258,266,19],[1920,1080,71]]){
  const game=Buffer.alloc(width*height*4),header=Buffer.alloc(width*headerHeight*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*4;game[i]=(x*17+y*3)%256;game[i+1]=(x*3+y*11)%256;game[i+2]=((x^y)*19)%256;game[i+3]=(x*y)%256;}
  for(let y=0;y<headerHeight;y++)for(let x=0;x<width;x++){const i=(y*width+x)*4;header[i]=(x*7)%256;header[i+1]=(y*23)%256;header[i+2]=255-x%256;header[i+3]=[0,1,127,128,254,255][Math.floor(x/13)%6];}
  const gameTexture=texture(0,width,height,game),headerTexture=texture(1,width,headerHeight,header),fbo=gl.createFramebuffer();
  gl.uniform2i(gl.getUniformLocation(program,'size'),width,height);
  const reference=Buffer.alloc(width*height*1.5),targets=[];let lastRGBA;
  for(let plane=0;plane<2;plane++){
    const w=plane?width/2:width,h=plane?height/2:height,target=texture(2,w,h,null,plane?2:1);
    gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,target,0);assert.equal(gl.checkFramebufferStatus(gl.FRAMEBUFFER),gl.FRAMEBUFFER_COMPLETE);
    gl.viewport(0,0,w,h);gl.disable(gl.BLEND);gl.disable(gl.SCISSOR_TEST);gl.uniform1i(gl.getUniformLocation(program,'mode'),plane);gl.drawArrays(gl.TRIANGLES,0,3);
    const rgba=new Uint8Array(w*h*4);gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,rgba);assert.equal(gl.getError(),gl.NO_ERROR);
    if(!plane)for(let i=0;i<w*h;i++)reference[i]=rgba[i*4];
    else for(let i=0;i<w*h;i++){reference[width*height+i*2]=rgba[i*4];reference[width*height+i*2+1]=rgba[i*4+1];}
    targets.push(target);lastRGBA=rgba;
  }
  const {nv12,h264,...result}=native.convertNV12(gl._n._replayEGL(),width,height,game,header,sharedContext);assert(result.passed,result.error);assert.equal(nv12.length,reference.length);
  // Poison the still-bound output, then draw again without rebinding the
  // original program/VAO/textures/viewport. A missing restore must not pass by
  // merely retaining the old pixels.
  gl.clearColor(0,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT);gl.drawArrays(gl.TRIANGLES,0,3);
  const resumed=new Uint8Array(lastRGBA.length);gl.readPixels(0,0,width/2,height/2,gl.RGBA,gl.UNSIGNED_BYTE,resumed);assert.deepEqual(resumed,lastRGBA,'Original GLES draw state restored after native compute');
  let maximumDifference=0,differingBytes=0,squaredError=0;for(let i=0;i<reference.length;i++){const error=Math.abs(nv12[i]-reference[i]);maximumDifference=Math.max(maximumDifference,error);differingBytes+=error!==0;squaredError+=error*error;}
  assert(maximumDifference<=1,`Compute/GLES raw NV12 difference ${maximumDifference} exceeds one quantization level`);
  const decoded=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-f','h264','-i','pipe:0','-frames:v','1','-pix_fmt','nv12','-f','rawvideo','pipe:1'],{input:h264,windowsHide:true,maxBuffer:16*1024*1024});assert.equal(decoded.status,0,decoded.stderr.toString());assert.equal(decoded.stdout.length,reference.length,'Encoded frame retains dimensions and crops');
  let encodedError=0;for(let i=0;i<nv12.length;i++)encodedError+=(nv12[i]-decoded.stdout[i])**2;
  const item={width,height,headerHeight,...result,bytes:reference.length,maximumDifference,differingBytes,rawPSNR:squaredError?10*Math.log10(255**2/(squaredError/reference.length)):'inf',encodedPSNR:10*Math.log10(255**2/(encodedError/nv12.length)),nativeH264Bytes:h264.length};reports.push(item);console.log(JSON.stringify(item));
  for(const target of targets)gl.deleteTexture(target);gl.deleteTexture(gameTexture);gl.deleteTexture(headerTexture);gl.deleteFramebuffer(fbo);
}
gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.clearColor(0,1,0,1);gl.clear(gl.COLOR_BUFFER_BIT);const pixel=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);assert.deepEqual([...pixel],[0,255,0,255]);
const report={reports,passed:true,originalContextUsable:true,note:'Raw compute conversion versus actual current GLES shader, plus GPU-fenced single-frame encoding. Synthetic inputs only; no reusable game-frame pool or replay speed claim.'};if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(report,null,2)+'\n');
