import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';
import {mediaFoundationAACArgs,createMediaFoundationAACInspector} from '../src/offline/windows-mf-audio.mjs';

assert.equal(process.platform,'win32');
const directory=await mkdtemp(path.join(tmpdir(),'replay-mf-audio-check-'));
function run(args,maxBuffer=16*1024*1024){const child=spawnSync(ffmpeg,args,{windowsHide:true,maxBuffer,timeout:20000});assert.equal(child.status,0,child.error?.message||child.stderr.toString());return child.stdout;}
function packetText(file){return run(['-hide_banner','-loglevel','error','-i',file,'-map','0:a:0','-c','copy','-f','framecrc','pipe:1']).toString();}
function packets(text){return text.split('\n').filter(line=>line&&!line.startsWith('#')).map(line=>line.split(',').map(value=>value.trim()));}
function waveform(file){const bytes=run(['-hide_banner','-loglevel','error','-i',file,'-map','0:a:0','-c:a','pcm_f32le','-f','f32le','pipe:1']);assert.equal(bytes.length%8,0);return new Float32Array(bytes.buffer,bytes.byteOffset,bytes.length/4);}
let seed=726581;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32-.5;};
try{
  for(const samples of [800,1024,1025,2048,2049,5120,25600,26400,27200,128000,192800,808800,960000]){
    const source=new Float32Array(samples*2);let left=0,right=0;
    for(let i=0;i<samples;i++){left=.85*left+.15*random();right=.83*right+.17*random();source[i*2]=left;source[i*2+1]=right;}
    const pcm=path.join(directory,'input.f32'),encoded=path.join(directory,'encoded.m4a'),trimmed=path.join(directory,'trimmed.m4a');
    await writeFile(pcm,Buffer.from(source.buffer));run(mediaFoundationAACArgs(pcm,encoded,48000));
    const text=packetText(encoded),inspector=createMediaFoundationAACInspector(samples,48000);for(const line of text.split('\n'))inspector.line(line);
    const coverage=inspector.finish(),expected=Math.ceil(samples/1024);assert.equal(coverage.requiredPackets,expected);
    const insufficient=createMediaFoundationAACInspector(samples+8192,48000);for(const line of text.split('\n'))insufficient.line(line);assert.throws(()=>insufficient.finish(),/complete stereo PCM timeline/);
    run(['-hide_banner','-loglevel','error','-nostdin','-y','-i',encoded,'-frames:a',String(expected),'-c:a','copy',trimmed]);
    const original=packets(text),actual=packets(packetText(trimmed));
    assert.equal(actual.length,expected,'Exactly the AAC packets covering the original timeline remain');
    for(let i=0;i<actual.length;i++){
      assert.equal(Number(actual[i][1]),i*1024,'Contiguous AAC DTS');assert.equal(Number(actual[i][2]),i*1024,'Contiguous AAC PTS');
      assert.deepEqual(actual[i].slice(4,6),original[i].slice(4,6),'Trimming copies each retained AAC packet unchanged');
    }
    const decoded=waveform(trimmed);assert.equal(decoded.length,expected*1024*2,'Complete decoded sample coverage with less than one AAC frame of padding');
    if(samples>48000){
      const first=16000,length=4096;let best=-Infinity,bestLag;
      for(let lag=-64;lag<=64;lag++){
        let xx=0,yy=0,xy=0;
        for(let i=0;i<length;i++)for(let channel=0;channel<2;channel++){const x=source[(first+i)*2+channel],y=decoded[(first+i+lag)*2+channel];xx+=x*x;yy+=y*y;xy+=x*y;}
        const score=xy/Math.sqrt(xx*yy);if(score>best){best=score;bestLag=lag;}
      }
      assert.equal(bestLag,0,'No decoded waveform shift');assert(best>.95,'Stereo waveform fidelity');
    }
  }
  console.log('PASS: 13 short/boundary/round-length clips retain exact AAC packet prefixes, zero timestamp starts, full sample coverage and stereo waveform alignment; insufficient encoder output is rejected.');
}finally{assert.equal(path.dirname(path.resolve(directory)),path.resolve(tmpdir()));assert(path.basename(directory).startsWith('replay-mf-audio-check-'));await rm(directory,{recursive:true,force:true});}
