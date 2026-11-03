#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import ffmpeg from 'ffmpeg-static';
async function frames(file){
  const child=spawn(ffmpeg,['-hide_banner','-loglevel','error','-i',file,'-map','0:v:0','-vsync','0','-f','framemd5','pipe:1'],{stdio:['ignore','pipe','pipe']});
  let output='',errors='';child.stdout.on('data',b=>{output+=b});child.stderr.on('data',b=>{errors=(errors+b).slice(-4000)});
  const[code]=await once(child,'exit');if(code!==0)throw Error(`Cannot decode ${file}: ${errors}`);
  return output.split('\n').filter(l=>l&&!l.startsWith('#')).map(l=>l.split(',').at(-1).trim());
}
async function main(){
  if(process.argv.length!==3)throw Error('Usage: node scripts/verify-rounds.mjs output.json');
  const report=JSON.parse(await readFile(process.argv[2],'utf8'));
  if(!Array.isArray(report.rounds)||!report.rounds.length)throw Error('Report has no progressive rounds');
  const master=await frames(report.output);
  if(master.length!==report.count)throw Error(`Master decoded ${master.length} frames, expected ${report.count}`);
  let cursor=0;
  for(const round of report.rounds){
    if(round.startFrame!==cursor||!Number.isInteger(round.endFrame)||round.endFrame<=cursor)throw Error('Invalid or noncontiguous round frame ranges');
    const decoded=await frames(round.path),expected=round.endFrame-round.startFrame;
    if(decoded.length!==expected)throw Error(`Round ${round.round}: decoded ${decoded.length} frames, expected ${expected}`);
    for(let i=0;i<decoded.length;i++)if(decoded[i]!==master[cursor+i])throw Error(`Round ${round.round}: frame ${i} differs from master`);
    if(round.pcmMatchesMaster!==true||!/^[a-f0-9]{64}$/.test(round.pcmSha256))throw Error(`Round ${round.round}: audio prefix was not verified by the exporter`);
    cursor=round.endFrame;
    console.log(`Round ${round.round}: ${expected} decoded frames identical; audio PCM verified during export.`);
  }
  if(cursor!==master.length)throw Error('Round files do not cover the entire master');
  console.log(`PASS: ${report.rounds.length} rounds cover all ${cursor} master frames without video re-encoding or dropped frames.`);
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
