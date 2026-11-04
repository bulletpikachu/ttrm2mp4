// Check actual decoded waveform alignment, not just container timestamps. This
// catches unreported AAC encoder delay, missing tails and quality regressions.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';

const [pcmFile,referenceFile,candidateFile,reportFile]=process.argv.slice(2);
assert(reportFile,'Usage: node scripts/verify-aac-fidelity.mjs stereo-48k.f32 reference.m4a candidate.m4a report.json');
const sourceBytes=await readFile(pcmFile),source=new Float32Array(sourceBytes.buffer,sourceBytes.byteOffset,sourceBytes.length/4),samples=source.length/2;
assert(Number.isInteger(samples));
function decode(file){
  const child=spawnSync(ffmpeg,['-hide_banner','-nostdin','-i',file,'-map','0:a:0','-vn','-c:a','pcm_f32le','-f','f32le','pipe:1'],{windowsHide:true,maxBuffer:sourceBytes.length+4*1024*1024});
  assert.equal(child.status,0,child.error?.message||child.stderr.toString());
  assert(/Audio: aac\b[^\r\n]*, 48000 Hz, stereo,/.test(child.stderr.toString()),'AAC must remain 48 kHz stereo');
  assert.equal(child.stdout.length%8,0);return new Float32Array(child.stdout.buffer,child.stdout.byteOffset,child.stdout.length/4);
}
function correlation(decoded,first,length,lag,stride){
  let xy=0,xx=0,yy=0;
  for(let frame=0;frame<length;frame+=stride)for(let channel=0;channel<2;channel++){
    const x=source[(first+frame)*2+channel],y=decoded[(first+frame+lag)*2+channel];xy+=x*y;xx+=x*x;yy+=y*y;
  }
  return xx>1e-10&&yy>1e-10?xy/Math.sqrt(xx*yy):-Infinity;
}
function delayAt(decoded,seconds){
  const first=Math.round(seconds*48000),length=16384,maxLag=4096;
  if(first<maxLag||first+length+maxLag>=Math.min(samples,decoded.length/2))return null;
  let bestLag=0,best=-Infinity;
  for(let lag=-maxLag;lag<=maxLag;lag+=8){const score=correlation(decoded,first,length,lag,8);if(score>best){best=score;bestLag=lag;}}
  if(!Number.isFinite(best))return null;
  const coarse=bestLag;best=-Infinity;
  for(let lag=coarse-8;lag<=coarse+8;lag++){const score=correlation(decoded,first,length,lag,1);if(score>best){best=score;bestLag=lag;}}
  return{seconds,lagSamples:bestLag,correlation:best};
}
function audit(file){
  const decoded=decode(file),windows=[1,3,10,30,60,120,180,240,300,317].map(seconds=>delayAt(decoded,seconds)).filter(Boolean);
  assert(windows.length>=2,'Need multiple non-silent alignment windows');
  const delays=windows.map(window=>window.lagSamples).sort((a,b)=>a-b),lag=delays[Math.floor(delays.length/2)];
  let energy=0,error=0,peak=0;
  const first=Math.max(4096,-lag),last=Math.min(samples-4096,decoded.length/2-lag-4096);
  for(let frame=first;frame<last;frame++)for(let channel=0;channel<2;channel++){
    const input=source[frame*2+channel],difference=decoded[(frame+lag)*2+channel]-input;energy+=input*input;error+=difference*difference;peak=Math.max(peak,Math.abs(input));
  }
  const snr=10*Math.log10(energy/error),decodedSamples=decoded.length/2;
  return{file:path.resolve(file),decodedSamples,paddingSamples:decodedSamples-samples,lagSamples:lag,sourcePeak:peak,alignedSNRdB:snr,windows,
    aligned:windows.every(window=>window.lagSamples===0&&window.correlation>.95),coverage:decodedSamples>=samples&&decodedSamples-samples<1024};
}
const reference=audit(referenceFile),candidate=audit(candidateFile);
candidate.snrDifferenceDB=candidate.alignedSNRdB-reference.alignedSNRdB;
const result={pcm:path.resolve(pcmFile),pcmSha256:createHash('sha256').update(sourceBytes).digest('hex'),samples,reference,candidate,
  passed:reference.aligned&&reference.coverage&&candidate.aligned&&candidate.coverage&&candidate.snrDifferenceDB>=-.1};
await writeFile(reportFile,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({reference:{lag:reference.lagSamples,padding:reference.paddingSamples,snr:reference.alignedSNRdB},candidate:{lag:candidate.lagSamples,padding:candidate.paddingSamples,snr:candidate.alignedSNRdB},passed:result.passed}));
assert(result.passed,'AAC candidate must preserve zero waveform delay, full sample coverage and reference quality');
