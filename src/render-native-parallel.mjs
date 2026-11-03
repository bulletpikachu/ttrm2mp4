#!/usr/bin/env node
// Every worker simulates the complete native match. Only drawing/encoding is
// divided; a simulation leader supplies one continuous, verified audio track.
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {access,mkdir,mkdtemp,open,readFile,rename,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import ffmpeg from 'ffmpeg-static';
import {createContinuousAudio} from './offline/continuous-audio.mjs';

const worker=fileURLToPath(new URL('./render.mjs',import.meta.url));
async function main(){
  const start=performance.now();
  const {values:o,positionals:p}=parseArgs({allowPositionals:true,options:{jobs:{type:'string',default:'3'},threads:{type:'string',default:'3'},width:{type:'string',default:'1920'},height:{type:'string',default:'1080'},fps:{type:'string',default:'60'},client:{type:'string',default:'client'},'central-encoder':{type:'boolean'},'stream-audio':{type:'boolean'},'quality-inputs-only':{type:'boolean'},'quality-samples':{type:'string'},'quality-interval':{type:'string',default:'2'},overwrite:{type:'boolean'},help:{type:'boolean'}}});
  if(o['central-encoder'])o['stream-audio']=true;
  if(o.help)return console.log('Usage: npm run render-native-parallel -- input.ttrm output.mp4 [--jobs 3 --threads 3] [--overwrite]\nExperimental Apple Silicon native rendering, full continuous audio, and progressive round files.\n--stream-audio: stream round PCM and reuse a renderer for the full audio reference.\n--central-encoder: share one native codec scheduling queue (implies stream-audio).\nBoth are experiments; current parallel measurements are slower than render-fast.');
  if(p.length!==2)throw Error('Provide input.ttrm and output.mp4');
  const jobs=Number(o.jobs),threads=Number(o.threads),width=Number(o.width),height=Number(o.height),fps=Number(o.fps);
  if(!Number.isInteger(jobs)||jobs<1||jobs>8||!Number.isInteger(threads)||threads<1||threads>16)throw Error('jobs must be 1–8 and threads 1–16');
  if(!Number.isInteger(width)||!Number.isInteger(height)||width%2||height%2||width<2||height<2||width>3840||height>2160||!Number.isInteger(fps)||fps<1||fps>60)throw Error('Invalid video dimensions or frame rate');
  const input=path.resolve(p[0]),output=path.resolve(p[1]),directory=output.replace(/\.mp4$/i,'-rounds'),reportFile=output.replace(/\.mp4$/i,'.json');
  if(!/\.ttrm$/i.test(input)||!/\.mp4$/i.test(output))throw Error('Expected .ttrm input and .mp4 output');
  const replay=JSON.parse(await readFile(input,'utf8')),rounds=replay.replay?.rounds;
  if(!Array.isArray(rounds)||!rounds.length||rounds.some(round=>!Array.isArray(round)||round.length!==2||round.some(player=>!Number.isFinite(player.replay?.frames)||player.replay.frames<=0||!Array.isArray(player.replay.events))))throw Error('Expected complete two-player multiplayer replay data');
  if(!o.overwrite)for(const target of [output,directory,reportFile]){try{await access(target);throw Error('Output exists: '+target)}catch(error){if(error.code!=='ENOENT')throw error}}
  await mkdir(path.dirname(output),{recursive:true});await mkdir(directory,{recursive:true});
  const temp=await mkdtemp(path.join(path.dirname(output),'.replay-render-parallel-'));
  const rawDirectory=path.join(temp,'raw');await mkdir(rawDirectory);
  const assignments=Array.from({length:Math.min(jobs,rounds.length)},()=>({rounds:[],frames:0}));
  for(const item of rounds.map((round,i)=>({round:i+1,frames:Math.max(...round.map(p=>p.replay.frames))})).sort((a,b)=>b.frames-a.frames)){
    const target=assignments.reduce((a,b)=>a.frames<=b.frames?a:b);target.rounds.push(item.round);target.frames+=item.frames;
  }
  if(o['quality-inputs-only']&&!o['quality-samples'])throw Error('quality-inputs-only requires quality-samples');
  const children=new Set(),tasks=[],publications=[],reports=new Map(),seen=new Set(),pendingAudio=new Map();let failure=null,leaderPCM=null,leader=null,continuousAudio=null,audioRound=1,continuousResult=null,centralSocket=null,centralService=null,centralDirectory=null,centralExit=null,closingCentral=false;
  const stop=()=>{for(const child of children){child.kill('SIGTERM');const force=setTimeout(()=>{if(children.has(child))child.kill('SIGKILL')},5000);force.unref()}};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  function launch(name,selection,audio=false){
    const stem=path.join(temp,name),args=[worker,input,stem+'.mp4','--engine','electron','--native-webgl','--native-encoder','--export-rounds','--worker-rounds',selection.length?selection.join(','):'none','--width',String(width),'--height',String(height),'--fps',String(fps),'--client',path.resolve(o.client),'--worker-video-dir',rawDirectory,'--overwrite'];
    if(audio)args.push('--worker-audio',path.join(temp,'master.f32'));
    if(selection.length&&o['quality-samples'])args.push('--quality-samples',path.resolve(o['quality-samples']),'--quality-interval',o['quality-interval'],...(o['quality-inputs-only']?['--quality-inputs-only']:[]));
    const child=spawn(process.execPath,args,{env:{...process.env,REPLAY_NATIVE_GL_TRUSTED:'1',REPLAY_X264_THREADS:String(threads),...(centralSocket?{REPLAY_CENTRAL_ENCODER:centralSocket,REPLAY_CENTRAL_MACH:centralService}:{})},stdio:['ignore','pipe','pipe','ipc']});children.add(child);
    let log='';const record=data=>{log=(log+data).slice(-12000)};child.stdout.on('data',record);child.stderr.on('data',record);
    child.on('message',message=>{
      if(message.type!=='round')return;
      const publication=publish(message.report).catch(error=>{failure??=error;stop()});publications.push(publication);
    });
    const task=(async()=>{
      const [code]=await once(child,'exit');children.delete(child);if(code!==0)throw Error(`${name} failed (${code}): ${log}`);
      return JSON.parse(await readFile(stem+'.json','utf8'));
    })();tasks.push(task);return task;
  }
  let leaderReady,audioTask=null;
  async function encodeContinuousAudio(){
    const child=spawn(ffmpeg,['-hide_banner','-loglevel','warning','-nostdin','-y','-f','f32le','-ar',String(leader.sampleRate),'-ac','2','-i',leader.workerAudio,'-vn','-c:a','aac','-b:a','192k','-movflags','+faststart',path.join(temp,'master.m4a')],{stdio:['ignore','ignore','pipe']});children.add(child);
    let errors='';child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-4000)});
    const [code]=await once(child,'exit');children.delete(child);if(code!==0)throw Error('Continuous audio encoding failed: '+errors);
  }
  function verifyRoundAudio(report){
    const expected=leader.timelineRounds.find(round=>round.round===report.round);
    if(!expected||report.startFrame!==expected.startFrame||report.endFrame!==expected.endFrame||report.partial||report.sampleRate!==leader.sampleRate)throw Error('Worker timeline differs from leader for round '+report.round);
    const first=Math.round(report.startFrame/fps*leader.sampleRate)*8,last=Math.round(report.endFrame/fps*leader.sampleRate)*8;
    const pcmSha256=createHash('sha256').update(leaderPCM.subarray(first,last)).digest('hex');
    if(pcmSha256!==report.pcmSha256)throw Error('Worker audio differs from continuous leader audio for round '+report.round);
    report.pcmMatchesMaster=true;
  }
  async function publish(report){
    if(seen.has(report.round))throw Error('Round was produced twice: '+report.round);seen.add(report.round);
    if(!Number.isInteger(report.round)||report.round<1||report.round>rounds.length||report.partial||report.fps!==fps||report.sampleRate!==48000)throw Error('Invalid worker round report');
    if(!o['stream-audio']){await leaderReady;verifyRoundAudio(report);}
    else{
      pendingAudio.set(report.round,report);
      while(pendingAudio.has(audioRound)){
        const next=pendingAudio.get(audioRound);pendingAudio.delete(audioRound++);
        continuousAudio??=createContinuousAudio(ffmpeg,path.join(temp,'master.m4a'),next.sampleRate);
        continuousAudio.append(path.join(rawDirectory,`round-${next.round}.f32`),next);
      }
    }
    const target=path.join(directory,`round-${String(report.round).padStart(2,'0')}.mp4`);
    await rename(report.path,target);
    const published={...report,path:target,publishedSeconds:(performance.now()-start)/1000};reports.set(report.round,published);
    console.log(`Round ${report.round} saved: ${target} (${published.publishedSeconds.toFixed(2)}s elapsed${published.pcmMatchesMaster?'; continuous PCM verified':''})`);
  }
  try{
    if(o['central-encoder']){
      centralDirectory=await mkdtemp('/private/tmp/replay-central-');centralSocket=path.join(centralDirectory,'encoder.sock');
      const server=spawn(process.execPath,[fileURLToPath(new URL('./experimental/central-encoder-server.mjs',import.meta.url)),centralSocket,temp,String(threads)],{stdio:['ignore','ignore','pipe','ipc']});children.add(server);
      let log='';server.stderr.on('data',chunk=>{log=(log+chunk).slice(-6000);console.error('Central encoder: '+chunk.toString().trim())});
      centralExit=once(server,'exit').then(([code])=>{children.delete(server);if(!closingCentral){failure??=Error(`Central encoder exited (${code}): ${log}`);stop();throw failure}});centralExit.catch(()=>{});
      await Promise.race([new Promise((resolve,reject)=>{server.once('message',message=>{if(message.type!=='ready'||typeof message.service!=='string')return reject(Error('Invalid central encoder startup message'));centralService=message.service;resolve()});server.once('error',reject)}),centralExit.then(()=>{throw Error('Central encoder stopped during startup')})]);
    }
    console.log(`Native replay: ${assignments.length} render workers × ${threads} encoder threads${o['stream-audio']?', with streamed continuous audio.':', plus continuous audio simulation.'}`);
    let renderTasks;
    const leaderTask=o['stream-audio']?(renderTasks=assignments.map((assignment,i)=>launch('renderer-'+i,assignment.rounds,i===0)))[0]:launch('audio-leader',[],true);
    leaderReady=leaderTask.then(async report=>{
      leader=report;leaderPCM=await readFile(report.workerAudio);
      if(leaderPCM.length!==report.samples*8||createHash('sha256').update(leaderPCM).digest('hex')!==report.audioPCMHash)throw Error('Leader PCM file verification failed');
      if(!o['stream-audio']){audioTask=encodeContinuousAudio().catch(error=>{failure??=error;stop()});tasks.push(audioTask);}
    });
    // Register failure handling immediately, including while workers are loading.
    leaderReady.catch(error=>{failure??=error;stop()});
    renderTasks??=assignments.map((assignment,i)=>launch('renderer-'+i,assignment.rounds));
    const results=await Promise.all([leaderReady,...renderTasks]);
    await Promise.all(publications);await audioTask;if(failure)throw failure;
    const workerReports=results.slice(1);
    for(const report of workerReports){
      if(JSON.stringify(report.timelineRounds)!==JSON.stringify(leader.timelineRounds)||report.audioPCMHash!==leader.audioPCMHash)throw Error('Workers disagree on the complete native timeline or audio');
      if(report.graphicsPreset!==leader.graphicsPreset||report.clientVersion!==leader.clientVersion||!report.networkingDisabled)throw Error('Worker client/graphics/offline settings differ');
    }
    if(reports.size!==rounds.length)throw Error(`Only ${reports.size} of ${rounds.length} rounds were published`);
    const ordered=[...reports.values()].sort((a,b)=>a.round-b.round);
    if(o['stream-audio']){
      for(const round of ordered)verifyRoundAudio(round);
      if(!continuousAudio||pendingAudio.size||audioRound!==rounds.length+1)throw Error('Continuous audio is missing round ranges');
      continuousResult=await continuousAudio.finish(leader.audioPCMHash,leader.samples*8);
    }
    let cursor=0;for(const round of ordered){if(round.startFrame!==cursor)throw Error('Round video ranges are not contiguous');cursor=round.endFrame}if(cursor!==leader.count)throw Error('Rounds do not cover the full leader timeline');
    const elementary=path.join(temp,'video.h264'),video=await open(elementary,'wx');
    try{for(const round of ordered)for await(const chunk of createReadStream(path.join(rawDirectory,`round-${round.round}.h264`)))await video.write(chunk)}finally{await video.close()}
    const staged=path.join(temp,'master.mp4'),encoder=spawn(ffmpeg,['-hide_banner','-loglevel','warning','-nostdin','-y','-r',String(fps),'-i',elementary,'-i',path.join(temp,'master.m4a'),'-map','0:v:0','-map','1:a:0','-c','copy','-movflags','+faststart',staged],{stdio:['ignore','ignore','pipe']});children.add(encoder);
    let errors='';encoder.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-6000)});const [code]=await once(encoder,'exit');children.delete(encoder);if(code!==0)throw Error('Final packaging failed: '+errors);
    await rename(staged,output);
    const elapsedSeconds=(performance.now()-start)/1000,duration=leader.count/fps;
    const report={input,output,width,height,fps,clientVersion:leader.clientVersion,networkingDisabled:true,graphicsPreset:leader.graphicsPreset,pipeline:o['central-encoder']?'parallel-native-angle-central-x264':'parallel-native-angle-iosurface-x264',jobs:assignments.length,threads,deterministic:true,count:leader.count,duration,sampleRate:leader.sampleRate,audioPCMHash:leader.audioPCMHash,continuousAudio:continuousResult,rounds:ordered,elapsedSeconds,speedup:duration/elapsedSeconds,audioLeader:{audioOnly:leader.audioOnly,encoderMode:leader.encoderMode,elapsedSeconds:leader.elapsedSeconds,timings:leader.timings,nativeWebGL:leader.nativeWebGL},workers:workerReports.map((r,i)=>({rounds:assignments[i].rounds,elapsedSeconds:r.elapsedSeconds,timings:r.timings,nativeWebGL:r.nativeWebGL})),missingAssets:workerReports.flatMap(r=>r.missingAssets),clientErrors:workerReports.flatMap(r=>r.clientErrors)};
    await writeFile(reportFile,JSON.stringify(report,null,2)+'\n');
    console.log(`Saved ${output}\n${duration.toFixed(2)}s video in ${elapsedSeconds.toFixed(2)}s total (${report.speedup.toFixed(2)}× real time).`);
  }catch(error){console.error('Parallel export failed: '+error.message);throw error}finally{
    closingCentral=true;stop();await Promise.allSettled(tasks);await Promise.allSettled(publications);await continuousAudio?.close();await centralExit?.catch(()=>{});
    process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);await rm(temp,{recursive:true,force:true});if(centralDirectory)await rm(centralDirectory,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1});
