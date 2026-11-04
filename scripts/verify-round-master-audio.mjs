import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';

const [input,output]=process.argv.slice(2);
if(!input||!output)throw Error('Usage: node scripts/verify-round-master-audio.mjs output.json audit.json');
const report=JSON.parse(await readFile(input,'utf8'));
assert.equal(report.audioEncoding?.copyRoundsFromMaster,true,'Export must use continuous AAC round copies');
async function decode(file,samples){
  const child=spawn(ffmpeg,['-hide_banner','-loglevel','info','-nostdin','-i',file,'-map','0:a:0','-af','ashowinfo','-c:a','pcm_f32le','-f','f32le','pipe:1'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  const chunks=[];let bytes=0,cursor=0,tail='',errors='',failure;
  function line(text){
    const frame=/Parsed_ashowinfo_.* n:(\d+)\s+pts:(-?\d+).*?channels:(\d+).*?rate:(\d+) nb_samples:(\d+)/.exec(text);if(!frame)return;
    try{assert.equal(Number(frame[2]),cursor,'Decoded AAC timestamps are contiguous and start at zero');assert.equal(Number(frame[3]),2);assert.equal(Number(frame[4]),report.sampleRate);cursor+=Number(frame[5]);}catch(error){failure??=error;child.kill('SIGTERM');}
  }
  child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>(samples+1023)*8){failure??=Error('Decoded AAC exceeds final packet padding allowance');child.kill('SIGTERM');}else chunks.push(chunk);});
  child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-2000);const lines=(tail+chunk).split(/[\r\n]+/);tail=lines.pop();lines.forEach(line);});
  await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>{line(tail);if(failure)reject(failure);else if(code!==0)reject(Error(errors));else resolve();});});
  assert.equal(bytes,cursor*8,'Every decoded stereo sample was captured');assert(cursor>=samples&&cursor-samples<1024,'Complete source coverage and bounded AAC padding');
  return{pcm:Buffer.concat(chunks),samples:cursor,padding:cursor-samples};
}
const master=await decode(report.output,report.samples),rounds=[];let cursor=0;
for(const round of report.rounds){
  assert.equal(round.startFrame,cursor);assert.equal(round.pcmMatchesMaster,true);assert.equal(round.audioCopiedFromMaster,true);
  const first=Math.round(round.startFrame/report.fps*report.sampleRate),last=Math.round(round.endFrame/report.fps*report.sampleRate),samples=last-first;
  const decoded=await decode(round.path,samples),expected=master.pcm.subarray(first*8,last*8),actual=decoded.pcm.subarray(0,samples*8);
  assert(actual.equals(expected),`Round ${round.round}: every decoded sample must equal its continuous-master range`);
  assert.equal(decoded.padding,round.audioPackets.paddingSamples);
  rounds.push({round:round.round,startSample:first,endSample:last,samples,paddingSamples:decoded.padding,decodedSha256:createHash('sha256').update(actual).digest('hex'),exactMaster:true,zeroBasedContiguousTimestamps:true});
  cursor=round.endFrame;
}
assert.equal(cursor,report.count);
await writeFile(output,JSON.stringify({report:path.resolve(input),masterSamples:report.samples,masterPadding:master.padding,rounds,passed:true},null,2)+'\n');
console.log(`PASS: all ${rounds.length} rounds retain every decoded continuous-master audio sample, zero-based contiguous timestamps and bounded final AAC padding.`);
