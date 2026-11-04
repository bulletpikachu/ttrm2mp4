import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import {createCanvas} from '../.native-deps/node-webgl-windows/dist/index.js';
const require=createRequire(import.meta.url),probe=require('../.native-deps/windows-gpu/windows-d3d12-probe.node');
const canvas=createCanvas(256,256),gl=canvas.getContext('webgl2');assert(gl);
const {h264,...result}=probe.computeNV12(gl._n._replayEGL());
if(h264){
  const decoded=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-f','h264','-i','pipe:0','-frames:v','1','-pix_fmt','yuv420p','-f','rawvideo','pipe:1'],{input:h264,windowsHide:true});
  assert.equal(decoded.status,0,decoded.stderr.toString());assert.equal(decoded.stdout.length,256*256*1.5);
  const count=256*256,values=[decoded.stdout.subarray(0,count),decoded.stdout.subarray(count,count*5/4),decoded.stdout.subarray(count*5/4)];
  result.decodedPlaneRanges=values.map(bytes=>({min:Math.min(...bytes),max:Math.max(...bytes)}));
  result.decodedPlaneRanges.forEach((range,i)=>{assert(Math.abs(range.min-[64,128,191][i])<=3);assert(Math.abs(range.max-[64,128,191][i])<=3);});
  result.nativeH264Bytes=h264.length;
}
gl.clearColor(0,1,0,1);gl.clear(gl.COLOR_BUFFER_BIT);const pixel=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);assert.deepEqual([...pixel],[0,255,0,255]);
const report={...result,originalContextUsable:true,note:'Single-frame separate-device NV12 plane UAV clear and GPU-fenced NVENC capability only; no conversion shader, pool reuse or replay speed claim.'};
if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));assert(result.passed,'Compute NV12 capability failed; inspect report');
