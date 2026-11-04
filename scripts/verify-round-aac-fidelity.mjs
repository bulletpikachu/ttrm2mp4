import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const [candidateFile,referenceFile,pcmFile,directory]=process.argv.slice(2);
assert(directory,'Usage: node scripts/verify-round-aac-fidelity.mjs candidate.json reference.json master.f32 audit-directory');
const candidate=JSON.parse(await readFile(candidateFile,'utf8')),reference=JSON.parse(await readFile(referenceFile,'utf8')),pcm=await readFile(pcmFile);
assert.equal(candidate.sampleRate,48000);assert.equal(reference.sampleRate,48000);assert.equal(candidate.fps,reference.fps);assert.equal(candidate.count,reference.count);assert.equal(candidate.samples,reference.samples);
assert.equal(createHash('sha256').update(pcm).digest('hex'),candidate.audioPCMHash);assert.equal(candidate.audioPCMHash,reference.audioPCMHash);assert.equal(pcm.length,candidate.samples*8);
assert.equal(candidate.rounds.length,reference.rounds.length);await mkdir(directory,{recursive:true});
const temporary=await mkdtemp(path.join(tmpdir(),'replay-aac-round-check-')),results=[];
try{
  for(const round of candidate.rounds){
    assert(Number.isInteger(round.round)&&round.round>0&&round.round<=candidate.rounds.length);
    const control=reference.rounds.find(item=>item.round===round.round);assert(control);
    assert.equal(round.startFrame,control.startFrame);assert.equal(round.endFrame,control.endFrame);assert.equal(round.pcmSha256,control.pcmSha256);
    const first=Math.round(round.startFrame/candidate.fps*48000),last=Math.round(round.endFrame/candidate.fps*48000);assert(first>=0&&last>first&&last<=candidate.samples);
    const source=pcm.subarray(first*8,last*8);assert.equal(createHash('sha256').update(source).digest('hex'),round.pcmSha256);
    const name=`round-${String(round.round).padStart(2,'0')}`,input=path.join(temporary,name+'.f32'),output=path.resolve(directory,name+'.json');await writeFile(input,source);
    const child=spawnSync(process.execPath,[fileURLToPath(new URL('./verify-aac-fidelity.mjs',import.meta.url)),input,control.path,round.path,output],{windowsHide:true,encoding:'utf8',timeout:60000});
    const report=JSON.parse(await readFile(output,'utf8'));Object.assign(report,{sourceMasterPCM:path.resolve(pcmFile),sourceStartSample:first,sourceEndSample:last,pcmTempRemoved:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');
    const result={round:round.round,passed:child.status===0&&report.passed,lag:report.candidate.lagSamples,padding:report.candidate.paddingSamples,snrDifferenceDB:report.candidate.snrDifferenceDB,report:output};results.push(result);console.log(JSON.stringify(result));
  }
  const report={candidate:path.resolve(candidateFile),reference:path.resolve(referenceFile),pcm:path.resolve(pcmFile),pcmSha256:candidate.audioPCMHash,results,passed:results.every(result=>result.passed)};
  await writeFile(path.join(directory,'summary.json'),JSON.stringify(report,null,2)+'\n');assert(report.passed,'Every decoded round must retain waveform alignment, sample coverage and reference quality');
}finally{assert.equal(path.dirname(path.resolve(temporary)),path.resolve(tmpdir()));assert(path.basename(temporary).startsWith('replay-aac-round-check-'));await rm(temporary,{recursive:true,force:true});}
