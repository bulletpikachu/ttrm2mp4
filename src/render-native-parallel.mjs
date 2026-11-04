#!/usr/bin/env node
// Drawing workers simulate from the match start (optionally through their last
// selected round); a complete leader supplies one continuous, verified audio track.
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {createReadStream,constants as fsConstants} from 'node:fs';
import {access,mkdir,mkdtemp,open,readFile,rename,rm,writeFile,copyFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {tmpdir} from 'node:os';
import ffmpeg from 'ffmpeg-static';
import {createContinuousAudio} from './offline/continuous-audio.mjs';
import {createContinuousMux} from './offline/continuous-mux.mjs';
import {verifyWorkerPrefix,verifyWorkerTimeline} from './offline/worker-integrity.mjs';
import {createVideoMux} from './offline/video-mux.mjs';
import {terminateWindowsProcessTree} from './offline/windows-process-tree.mjs';
import {mediaFoundationAACArgs,createMediaFoundationAACInspector} from './offline/windows-mf-audio.mjs';
import {makeFrameWindows,verifyFrameWorker,createFragmentCollector} from './offline/frame-ranges.mjs';

const worker=fileURLToPath(new URL('./render.mjs',import.meta.url));
async function publishFile(source,target){
  try{await rename(source,target)}catch(error){if(error.code!=='EXDEV')throw error;const staged=path.join(path.dirname(target),`.${path.basename(target)}.${randomUUID()}.partial`);try{await copyFile(source,staged,fsConstants.COPYFILE_EXCL);await rename(staged,target)}finally{await rm(staged,{force:true})}}
}
async function main(){
  const start=performance.now();
  const hostTimings={};
  const {values:o,positionals:p}=parseArgs({allowPositionals:true,options:{backend:{type:'string',default:'mac'},jobs:{type:'string',default:'3'},threads:{type:'string',default:'3'},width:{type:'string',default:'1920'},height:{type:'string',default:'1080'},fps:{type:'string',default:'60'},client:{type:'string',default:'client'},'central-encoder':{type:'boolean'},'stream-audio':{type:'boolean'},'quality-inputs-only':{type:'boolean'},'quality-samples':{type:'string'},'quality-interval':{type:'string',default:'2'},overwrite:{type:'boolean'},help:{type:'boolean'}}});
  const windows=o.backend==='windows';if(!['mac','windows'].includes(o.backend))throw Error('backend must be mac or windows');
  const mfAudio=windows&&process.env.REPLAY_WINDOWS_MF_AUDIO==='1';
  const dedicatedAudio=windows&&(mfAudio||process.env.REPLAY_DEDICATED_AUDIO==='1');
  const frameRanges=windows&&process.env.REPLAY_WINDOWS_FRAME_RANGES==='1';
  const frameSimulationWeight=Number(process.env.REPLAY_WINDOWS_FRAME_SIMULATION_WEIGHT||0);
  if(frameRanges&&(!Number.isFinite(frameSimulationWeight)||frameSimulationWeight<0||frameSimulationWeight>10))throw Error('Invalid frame-window simulation weight');
  if(frameRanges&&!dedicatedAudio)throw Error('Frame-range rendering requires a complete separate audio leader');
  if(windows&&process.env.REPLAY_WINDOWS_AUDIO_PARTICLES==='1'&&!dedicatedAudio)throw Error('Audio-only particle optimization requires a separate complete audio leader');
  const prefixWorkers=windows&&(dedicatedAudio||process.env.REPLAY_WORKER_PREFIX==='1');
  if(windows&&(process.platform!=='win32'||process.arch!=='x64'||o['central-encoder']))throw Error('Windows backend requires Windows x64 and does not use the Mac central encoder');
  const windowsEnv=windows?{REPLAY_FAST_YIELD:'1',REPLAY_GL_BATCH:'1',REPLAY_GL_ASYNC:'1',REPLAY_GL_POOL:'1',REPLAY_GL_DEFER_FLUSH:'1',REPLAY_GL_SPECIALIZE:'1',REPLAY_WINDOWS_NV12:'1',REPLAY_WINDOWS_ASYNC:'1',REPLAY_WINDOWS_FENCE:'1',REPLAY_WINDOWS_DIRECT_TEXTURE:'1',REPLAY_NATIVE_INTERLEAVE:'1',REPLAY_AUDIO_DECODE_CACHE:'1',REPLAY_FINAL_AUDIO_REUSE:'1',REPLAY_OVERLAP_ROUND_AUDIO:'1',REPLAY_FORMAT_CACHE:'1',REPLAY_RESERVE_MOOV:'1'}:{};
  if(windows)o['stream-audio']=!dedicatedAudio;
  if(windows)process.env.REPLAY_RESERVE_MOOV??='1';
  const profileDirectory=windows&&process.env.REPLAY_WORKER_PROFILES?path.resolve(process.env.REPLAY_WORKER_PROFILES):null;
  if(o['central-encoder'])o['stream-audio']=true;
  if(o.help)return console.log('Usage: npm run render-native-parallel -- input.ttrm output.mp4 [--backend mac|windows] [--jobs 3 --threads 3] [--overwrite]\nExperimental native rendering, full continuous audio, and progressive round files.\nWindows uses D3D11/NVENC with continuous audio; threads applies to Mac x264 only.\n--stream-audio: stream round PCM and reuse a renderer for the full audio reference.\nWindows REPLAY_WINDOWS_MF_AUDIO=1: use a dedicated audio leader and Media Foundation AAC.\n--central-encoder: Mac only, share one native codec scheduling queue.');
  if(p.length!==2)throw Error('Provide input.ttrm and output.mp4');
  if(profileDirectory)await mkdir(profileDirectory,{recursive:true});
  const jobs=Number(o.jobs),threads=Number(o.threads),width=Number(o.width),height=Number(o.height),fps=Number(o.fps);
  if(!Number.isInteger(jobs)||jobs<1||jobs>8||!Number.isInteger(threads)||threads<1||threads>16)throw Error('jobs must be 1–8 and threads 1–16');
  if(!Number.isInteger(width)||!Number.isInteger(height)||width%2||height%2||width<2||height<2||width>3840||height>2160||!Number.isInteger(fps)||fps<1||fps>60)throw Error('Invalid video dimensions or frame rate');
  const input=path.resolve(p[0]),output=path.resolve(p[1]),directory=output.replace(/\.mp4$/i,'-rounds'),reportFile=output.replace(/\.mp4$/i,'.json');
  if(!/\.ttrm$/i.test(input)||!/\.mp4$/i.test(output))throw Error('Expected .ttrm input and .mp4 output');
  const replay=JSON.parse(await readFile(input,'utf8')),rounds=replay.replay?.rounds;
  if(!Array.isArray(rounds)||!rounds.length||rounds.some(round=>!Array.isArray(round)||round.length!==2||round.some(player=>!Number.isFinite(player.replay?.frames)||player.replay.frames<=0||!Array.isArray(player.replay.events))))throw Error('Expected complete two-player multiplayer replay data');
  if(!o.overwrite)for(const target of [output,directory,reportFile]){try{await access(target);throw Error('Output exists: '+target)}catch(error){if(error.code!=='ENOENT')throw error}}
  await mkdir(path.dirname(output),{recursive:true});await mkdir(directory,{recursive:true});
  const temp=await mkdtemp(path.join(windows?tmpdir():path.dirname(output),windows?'replay-win-parallel-':'.replay-render-parallel-'));
  const rawDirectory=path.join(temp,'raw');await mkdir(rawDirectory);
  let assignments=Array.from({length:Math.min(jobs,rounds.length)},()=>({rounds:[],frames:0}));
  for(const item of rounds.map((round,i)=>({round:i+1,frames:Math.max(...round.map(p=>p.replay.frames))})).sort((a,b)=>b.frames-a.frames)){
    const target=assignments.reduce((a,b)=>a.frames<=b.frames?a:b);target.rounds.push(item.round);target.frames+=item.frames;
  }
  if(frameRanges){
    const estimate=Math.ceil(rounds.reduce((sum,round)=>sum+Math.max(...round.map(player=>player.replay.frames))*fps/60+fps*2,0));
    assignments=makeFrameWindows(estimate,jobs,fps,{simulationWeight:frameSimulationWeight}).map(frameWindow=>({rounds:rounds.map((_,i)=>i+1),frameWindow}));
  }
  const leaderIndex=dedicatedAudio?null:prefixWorkers?assignments.findIndex(assignment=>assignment.rounds.includes(rounds.length)):0;
  if(o['quality-inputs-only']&&!o['quality-samples'])throw Error('quality-inputs-only requires quality-samples');
  const children=new Set(),tasks=[],publications=[],reports=new Map(),seen=new Set(),pendingAudio=new Map();let failure=null,leaderPCM=null,leader=null,continuousAudio=null,continuousMux=null,videoMux=null,audioRound=1,continuousResult=null,centralSocket=null,centralService=null,centralDirectory=null,centralExit=null,closingCentral=false;
  const stopping=new Set(),stopTasks=[];
  const rawParts=new Map();let fragmentCollector=null;
  const stop=()=>{for(const child of children){
    if(windows){
      if(stopping.has(child))continue;stopping.add(child);
      stopTasks.push(terminateWindowsProcessTree(child).catch(error=>{failure??=error}));
    }else{child.kill('SIGTERM');const force=setTimeout(()=>{if(children.has(child))child.kill('SIGKILL')},5000);force.unref()}
  }};
  let resolveEarlyAudio;const earlyAudio=dedicatedAudio?new Promise(resolve=>{resolveEarlyAudio=resolve}):null;
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  function launch(name,selection,audio=false,frameWindow=null){
    const stem=path.join(temp,name),args=[worker,input,stem+'.mp4','--engine','electron','--native-webgl',windows?'--windows-encoder':'--native-encoder','--export-rounds','--worker-rounds',selection.length?selection.join(','):'none','--width',String(width),'--height',String(height),'--fps',String(fps),'--client',path.resolve(o.client),'--worker-video-dir',rawDirectory,'--overwrite'];
    if(audio)args.push('--worker-audio',path.join(temp,'master.f32'));
    if(frameWindow)args.push('--worker-frames',JSON.stringify(frameWindow));
    if(profileDirectory)args.push('--profile',path.join(profileDirectory,name+'.json'));
    if(selection.length&&o['quality-samples'])args.push('--quality-samples',path.resolve(o['quality-samples']),'--quality-interval',o['quality-interval'],...(o['quality-inputs-only']?['--quality-inputs-only']:[]));
    const child=spawn(process.execPath,args,{env:{...windowsEnv,...process.env,REPLAY_NATIVE_GL_TRUSTED:'1',REPLAY_X264_THREADS:String(threads),...(dedicatedAudio?{REPLAY_WORKER_PREFIX:'1',REPLAY_WORKER_VIDEO_ONLY:selection.length?'1':'0',REPLAY_EARLY_AUDIO:audio&&!selection.length?'1':'0'}:{}),...(centralSocket?{REPLAY_CENTRAL_ENCODER:centralSocket,REPLAY_CENTRAL_MACH:centralService}:{})},stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});children.add(child);
    let log='';const record=data=>{log=(log+data).slice(-12000)};child.stdout.on('data',record);child.stderr.on('data',record);
    child.on('message',message=>{
      if(message.type==='audio-ready'&&dedicatedAudio&&audio&&!selection.length){resolveEarlyAudio(message.report);return;}
      if(message.type!==(frameWindow?'video-fragment':dedicatedAudio?'video-round':'round'))return;
      const publication=(frameWindow?acceptFragment(message.report,frameWindow):publish(message.report)).catch(error=>{failure??=error;stop()});publications.push(publication);
    });
    const task=(async()=>{
      const [code]=await once(child,'exit');children.delete(child);if(code!==0)throw Error(`${name} failed (${code}): ${log}`);
      return JSON.parse(await readFile(stem+'.json','utf8'));
    })();tasks.push(task);return task;
  }
  let leaderReady,audioTask=null,masterAudioPackets=null;
  async function runFFmpeg(args,label,onLine=null){
    const child=spawn(ffmpeg,args,{stdio:['ignore',onLine?'pipe':'ignore','pipe'],windowsHide:true});children.add(child);
    let errors='';child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-4000)});
    let partial='',parseFailure;
    if(onLine)child.stdout.on('data',chunk=>{
      const lines=(partial+chunk).split('\n');partial=lines.pop();
      try{for(const line of lines)onLine(line)}catch(error){parseFailure??=error;child.kill('SIGTERM');}
    });
    try{
      const [code]=await once(child,'close');if(parseFailure)throw parseFailure;
      if(onLine&&partial)onLine(partial);if(code!==0)throw Error(label+': '+errors);
    }finally{children.delete(child);}
  }
  async function inspectAAC(file,samples){
    const inspector=createMediaFoundationAACInspector(samples,leader.sampleRate);
    await runFFmpeg(['-hide_banner','-loglevel','error','-nostdin','-i',file,'-map','0:a:0','-c:a','copy','-f','framecrc','pipe:1'],'Windows AAC coverage verification failed',inspector.line);
    return inspector.finish();
  }
  async function encodeContinuousAudio(){
    const target=path.join(temp,'master.m4a');
    await runFFmpeg(mfAudio?mediaFoundationAACArgs(leader.workerAudio,target,leader.sampleRate):['-hide_banner','-loglevel','warning','-nostdin','-y','-f','f32le','-ar',String(leader.sampleRate),'-ac','2','-i',leader.workerAudio,'-vn','-c:a','aac',...(dedicatedAudio?['-threads','1']:[]),'-b:a','192k','-movflags','+faststart',target],'Continuous audio encoding failed');
    if(mfAudio)masterAudioPackets=await inspectAAC(target,leader.samples);
    if(dedicatedAudio){hostTimings.audioEncodedSeconds=(performance.now()-start)/1000;videoMux=await createVideoMux(ffmpeg,path.join(temp,'master.mp4'),fps,target,leader.count,{audioPacketLimit:mfAudio?masterAudioPackets.requiredPackets:null});pumpVideo();}
  }
  function pumpVideo(){if(!videoMux)return;while(pendingAudio.has(audioRound)){const next=pendingAudio.get(audioRound);pendingAudio.delete(audioRound++);videoMux.append(rawParts.get(next.round)||path.join(rawDirectory,`round-${next.round}.h264`),next);}}
  async function packageRound(report,pcm,target){
    const staged=path.join(temp,`packaged-${report.round}.mp4`),frames=report.endFrame-report.startFrame;
    const pieces=rawParts.get(report.round)||[path.join(rawDirectory,`round-${report.round}.h264`)];let videoInput=pieces[0];
    if(pieces.length>1){
      const list=path.join(temp,`round-${report.round}.inputs`);await writeFile(list,pieces.map(file=>'file:'+file.replaceAll('\\','/')).join('\n')+'\n',{flag:'wx'});videoInput='concatf:'+list.replaceAll('\\','/');
    }
    if(mfAudio){
      const encoded=path.join(temp,`audio-${report.round}.m4a`);
      await runFFmpeg(mediaFoundationAACArgs(pcm,encoded,leader.sampleRate),'Windows round AAC encoding failed');
      const samples=Math.round(report.endFrame/fps*leader.sampleRate)-Math.round(report.startFrame/fps*leader.sampleRate);
      report.audioPackets=await inspectAAC(encoded,samples);
      await runFFmpeg(['-hide_banner','-loglevel','warning','-nostdin','-y','-r',String(fps),'-f','h264','-i',videoInput,'-i',encoded,'-map','0:v:0','-map','1:a:0','-c','copy','-frames:a',String(report.audioPackets.requiredPackets),'-moov_size',String(Math.max(1048576,frames*64+1048576)),staged],'Windows round packaging failed');
      await publishFile(staged,target);return;
    }
    const child=spawn(ffmpeg,['-hide_banner','-loglevel','warning','-nostdin','-y','-r',String(fps),'-f','h264','-i',videoInput,'-f','f32le','-ar',String(leader.sampleRate),'-ac','2','-i',pcm,'-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-threads','1','-b:a','192k','-moov_size',String(Math.max(1048576,frames*64+1048576)),staged],{stdio:['ignore','ignore','pipe'],windowsHide:true});children.add(child);
    let errors='';child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-4000)});const [code]=await once(child,'exit');children.delete(child);if(code!==0)throw Error('Round packaging failed: '+errors);await publishFile(staged,target);
  }
  function verifyRoundAudio(report){
    const expected=leader.timelineRounds.find(round=>round.round===report.round);
    if(!expected||report.startFrame!==expected.startFrame||report.endFrame!==expected.endFrame||report.partial||report.sampleRate!==leader.sampleRate)throw Error('Worker timeline differs from leader for round '+report.round);
    const first=Math.round(report.startFrame/fps*leader.sampleRate)*8,last=Math.round(report.endFrame/fps*leader.sampleRate)*8;
    const pcmSha256=createHash('sha256').update(leaderPCM.subarray(first,last)).digest('hex');
    if(pcmSha256!==report.pcmSha256)throw Error('Worker audio differs from continuous leader audio for round '+report.round);
    report.pcmMatchesMaster=true;
  }
  async function acceptFragment(report,frameWindow){
    await leaderReady;fragmentCollector??=createFragmentCollector(leader);
    const complete=fragmentCollector.add(report,frameWindow);if(!complete)return;
    rawParts.set(complete.round,complete.fragments.map(part=>path.join(rawDirectory,`fragment-${part.round}-${part.startFrame}-${part.endFrame}.h264`)));
    await publish({...complete,fps,sampleRate:leader.sampleRate,partial:false,audioFromLeader:true,pcmSha256:null});
  }
  async function publish(report){
    if(seen.has(report.round))throw Error('Round was produced twice: '+report.round);seen.add(report.round);
    if(!Number.isInteger(report.round)||report.round<1||report.round>rounds.length||report.partial||report.fps!==fps||report.sampleRate!==48000)throw Error('Invalid worker round report');
    if(dedicatedAudio){
      await leaderReady;if(report.audioFromLeader!==true||report.pcmSha256!==null)throw Error('Invalid video-only round report');
      const expected=leader.timelineRounds.find(round=>round.round===report.round);if(!expected||expected.startFrame!==report.startFrame||expected.endFrame!==report.endFrame)throw Error('Video-only round timeline differs from audio leader');
      const first=Math.round(report.startFrame/fps*leader.sampleRate)*8,last=Math.round(report.endFrame/fps*leader.sampleRate)*8,pcm=path.join(rawDirectory,`round-${report.round}.f32`),expectedPCM=leaderPCM.subarray(first,last);
      await writeFile(pcm,expectedPCM,{flag:'wx'});const written=await readFile(pcm);if(!written.equals(expectedPCM))throw Error('Written round PCM differs from the complete audio leader');report.pcmSha256=createHash('sha256').update(written).digest('hex');verifyRoundAudio(report);
      pendingAudio.set(report.round,report);pumpVideo();
      const target=path.join(directory,`round-${String(report.round).padStart(2,'0')}.mp4`);await packageRound(report,pcm,target);
      const published={...report,...(mfAudio?{audioEncoder:"aac_mf"}:{}),path:target,publishedSeconds:(performance.now()-start)/1000};reports.set(report.round,published);console.log(`Round ${report.round} saved: ${target} (${published.publishedSeconds.toFixed(2)}s elapsed; continuous leader PCM verified)`);return;
    }
    if(!o['stream-audio']){await leaderReady;verifyRoundAudio(report);}
    else{
      pendingAudio.set(report.round,report);
      while(pendingAudio.has(audioRound)){
        const next=pendingAudio.get(audioRound);pendingAudio.delete(audioRound++);
        if(windows){
          const maxFrames=rounds.reduce((sum,round)=>sum+Math.max(...round.map(player=>player.replay.frames)),0)+fps*(rounds.length*10+30);
          continuousMux??=createContinuousMux(ffmpeg,path.join(temp,'master.mp4'),fps,next.sampleRate,maxFrames);
          continuousMux.append(path.join(rawDirectory,`round-${next.round}.h264`),path.join(rawDirectory,`round-${next.round}.f32`),next);
        }else{
          continuousAudio??=createContinuousAudio(ffmpeg,path.join(temp,'master.m4a'),next.sampleRate);
          continuousAudio.append(path.join(rawDirectory,`round-${next.round}.f32`),next);
        }
      }
    }
    const target=path.join(directory,`round-${String(report.round).padStart(2,'0')}.mp4`);
    await publishFile(report.path,target);
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
    console.log(`Native replay: ${assignments.length} render workers${windows?` using ${process.env.REPLAY_WINDOWS_D3D12==='1'?'D3D12':'D3D11'}/NVENC`:` × ${threads} encoder threads`}${o['stream-audio']?', with streamed continuous audio.':', plus continuous audio simulation.'}`);
    let renderTasks;
    const leaderTask=o['stream-audio']?(renderTasks=assignments.map((assignment,i)=>launch('renderer-'+i,assignment.rounds,i===leaderIndex)))[leaderIndex]:launch('audio-leader',[],true);
    leaderReady=(dedicatedAudio?Promise.race([earlyAudio,leaderTask]):leaderTask).then(async report=>{
      leader=report;leaderPCM=await readFile(report.workerAudio);
      hostTimings.audioLeaderReadySeconds=(performance.now()-start)/1000;
      if(prefixWorkers&&(!leader.finished||leader.completedPrefix||leader.timelineRounds.length!==rounds.length))throw Error('Audio leader did not finish the complete match');
      if(leaderPCM.length!==report.samples*8||createHash('sha256').update(leaderPCM).digest('hex')!==report.audioPCMHash)throw Error('Leader PCM file verification failed');
      if(!o['stream-audio']){audioTask=encodeContinuousAudio().catch(error=>{failure??=error;stop()});tasks.push(audioTask);}
    });
    // Register failure handling immediately, including while workers are loading.
    leaderReady.catch(error=>{failure??=error;stop()});
    renderTasks??=assignments.map((assignment,i)=>launch('renderer-'+i,assignment.rounds,false,assignment.frameWindow));
    const results=await Promise.all([leaderReady,...renderTasks]);
    if(dedicatedAudio){const completedLeader=await leaderTask;if(completedLeader.audioPCMHash!==leader.audioPCMHash||completedLeader.count!==leader.count||completedLeader.samples!==leader.samples||JSON.stringify(completedLeader.timelineRounds)!==JSON.stringify(leader.timelineRounds))throw Error('Audio leader final result differs from its early handoff');leader=completedLeader;}
    hostTimings.workersFinishedSeconds=(performance.now()-start)/1000;
    await Promise.all(publications);await audioTask;if(failure)throw failure;
    const workerReports=results.slice(1);
    if(leader.missingAssets?.length||leader.clientErrors?.length)throw Error('Audio leader reported missing assets or client errors');
    for(const [workerIndex,report] of workerReports.entries()){
      if(frameRanges)report.frameVerification=verifyFrameWorker(report,leader,assignments[workerIndex].frameWindow);
      else if(dedicatedAudio){if(!report.videoOnlyWorker||report.audioPCMHash!==null)throw Error('Drawing worker unexpectedly rendered audio');report.timelineVerification=verifyWorkerTimeline(report,leader);}
      else if(prefixWorkers)report.prefixVerification=verifyWorkerPrefix(report,leader,leaderPCM);
      else if(JSON.stringify(report.timelineRounds)!==JSON.stringify(leader.timelineRounds)||report.audioPCMHash!==leader.audioPCMHash)throw Error('Workers disagree on the complete native timeline or audio');
      if(report.graphicsPreset!==leader.graphicsPreset||report.clientVersion!==leader.clientVersion||!report.networkingDisabled)throw Error('Worker client/graphics/offline settings differ');
    }
    if(frameRanges)fragmentCollector?.finish();
    if(reports.size!==rounds.length)throw Error(`Only ${reports.size} of ${rounds.length} rounds were published`);
    const ordered=[...reports.values()].sort((a,b)=>a.round-b.round);
    if(dedicatedAudio){if(!videoMux||pendingAudio.size||audioRound!==rounds.length+1)throw Error('Video copy mux is missing round ranges');hostTimings.inputsVerifiedSeconds=(performance.now()-start)/1000;continuousResult=await videoMux.finish(leader.count);hostTimings.muxFinishedSeconds=(performance.now()-start)/1000;}
    if(o['stream-audio']){
      for(const round of ordered)verifyRoundAudio(round);
      if((windows?!continuousMux:!continuousAudio)||pendingAudio.size||audioRound!==rounds.length+1)throw Error('Continuous audio is missing round ranges');
      hostTimings.inputsVerifiedSeconds=(performance.now()-start)/1000;
      continuousResult=windows?await continuousMux.finish(leader.audioPCMHash,leader.samples*8,leader.count):await continuousAudio.finish(leader.audioPCMHash,leader.samples*8);
      hostTimings.muxFinishedSeconds=(performance.now()-start)/1000;
    }
    let cursor=0;for(const round of ordered){if(round.startFrame!==cursor)throw Error('Round video ranges are not contiguous');cursor=round.endFrame}if(cursor!==leader.count)throw Error('Rounds do not cover the full leader timeline');
    if(!windows){
    const elementary=path.join(temp,'video.h264'),video=await open(elementary,'wx');
    try{for(const round of ordered)for await(const chunk of createReadStream(path.join(rawDirectory,`round-${round.round}.h264`)))await video.write(chunk)}finally{await video.close()}
    const index=windows?['-moov_size',String(Math.max(1048576,leader.count*64+1048576))]:['-movflags','+faststart'];
    const staged=path.join(temp,'master.mp4'),encoder=spawn(ffmpeg,['-hide_banner','-loglevel','warning','-nostdin','-y','-r',String(fps),'-i',elementary,'-i',path.join(temp,'master.m4a'),'-map','0:v:0','-map','1:a:0','-c','copy',...index,staged],{stdio:['ignore','ignore','pipe'],windowsHide:true});children.add(encoder);
    let errors='';encoder.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-6000)});const [code]=await once(encoder,'exit');children.delete(encoder);if(code!==0)throw Error('Final packaging failed: '+errors);
    await publishFile(staged,output);
    }else await publishFile(path.join(temp,'master.mp4'),output);
    hostTimings.publishedSeconds=(performance.now()-start)/1000;
    const elapsedSeconds=(performance.now()-start)/1000,duration=leader.count/fps;
    const report={input,output,width,height,fps,clientVersion:leader.clientVersion,networkingDisabled:true,graphicsPreset:leader.graphicsPreset,pipeline:windows?'parallel-native-angle-d3d11-nvenc':o['central-encoder']?'parallel-native-angle-central-x264':'parallel-native-angle-iosurface-x264',jobs:assignments.length,threads:windows?null:threads,deterministic:true,count:leader.count,samples:leader.samples,duration,sampleRate:leader.sampleRate,audioPCMHash:leader.audioPCMHash,...(dedicatedAudio?{masterMux:continuousResult,audioReference:{pcmSha256:leader.audioPCMHash,samples:leader.samples,source:"complete-native-audio-leader"}}:windows?{continuousMux:continuousResult}:{continuousAudio:continuousResult}),rounds:ordered,elapsedSeconds,speedup:duration/elapsedSeconds,audioLeader:{audioOnly:leader.audioOnly,audioOnlyParticleUpdates:leader.audioOnlyParticleUpdates,encoderMode:leader.encoderMode,elapsedSeconds:leader.elapsedSeconds,hostTimings:leader.hostTimings,timings:leader.timings,nativeWebGL:leader.nativeWebGL},workers:workerReports.map((r,i)=>({rounds:assignments[i].rounds,elapsedSeconds:r.elapsedSeconds,timings:r.timings,nativeWebGL:r.nativeWebGL})),missingAssets:workerReports.flatMap(r=>r.missingAssets),clientErrors:workerReports.flatMap(r=>r.clientErrors)};
    if(windows){report.hostTimings=hostTimings;report.prefixWorkers=prefixWorkers;report.dedicatedAudio=dedicatedAudio;report.frameRanges=frameRanges;if(frameRanges)report.frameSimulationWeight=frameSimulationWeight;if(mfAudio)report.audioEncoding={codec:"aac_mf",bitrate:192000,inputFormat:"s16",paddingBlockSamples:2048,flushPaddingSamples:2048,trimEncodedPadding:true,masterPackets:masterAudioPackets};report.leaderIndex=leaderIndex;if(profileDirectory)report.workerProfiles=profileDirectory;report.workers.forEach((worker,i)=>{worker.hostTimings=workerReports[i].hostTimings;worker.renderSeconds=workerReports[i].renderSeconds;if(frameRanges){worker.frameWindow=workerReports[i].frameWindow;worker.frameVerification=workerReports[i].frameVerification;worker.encodedCount=workerReports[i].encodedCount;worker.completedFrameWindow=workerReports[i].completedFrameWindow;worker.warmups=workerReports[i].warmups;}if(prefixWorkers){worker.prefixVerification=workerReports[i].prefixVerification;worker.timelineVerification=workerReports[i].timelineVerification;worker.videoOnlyWorker=workerReports[i].videoOnlyWorker;worker.count=workerReports[i].count;worker.completedPrefix=workerReports[i].completedPrefix;}});}
    if(windows&&process.env.REPLAY_WINDOWS_D3D12==='1'){
      if(workerReports.some(worker=>worker.nativeWebGL?.encoder?.d3d12!==1))throw Error('Requested D3D12 encoder was not used by every drawing worker');
      report.pipeline='parallel-native-angle-d3d12-nvenc';
    }
    if(windows&&process.env.REPLAY_WINDOWS_COMPUTE==='1'){
      if(workerReports.some(worker=>worker.nativeWebGL?.encoder?.computeConversion!==1))throw Error('Requested compute conversion was not used by every drawing worker');
      report.pipeline='parallel-native-angle-compute-d3d12-nvenc';
    }
    if(windows&&process.env.REPLAY_WINDOWS_COMPUTE_INPLACE==='1'){
      if(workerReports.some(worker=>worker.nativeWebGL?.encoder?.computeInPlace!==1))throw Error('Requested in-place conversion was not used by every drawing worker');
      report.pipeline='parallel-native-angle-inplace-compute-d3d12-nvenc';
    }
    if(windows){
      report.audioLeader.localClientTransport=leader.localClientTransport;
      report.workers.forEach((worker,i)=>{worker.localClientTransport=workerReports[i].localClientTransport;});
      if(process.env.REPLAY_WINDOWS_NATIVE_CLIENT==='1'&&(leader.localClientTransport!=='electron-protocol'||workerReports.some(worker=>worker.localClientTransport!=='electron-protocol')))throw Error('Requested Electron client transport was not used by every worker');
    }
    await writeFile(reportFile,JSON.stringify(report,null,2)+'\n');
    console.log(`Saved ${output}\n${duration.toFixed(2)}s video in ${elapsedSeconds.toFixed(2)}s total (${report.speedup.toFixed(2)}× real time).`);
  }catch(error){console.error('Parallel export failed: '+error.message);throw error}finally{
    closingCentral=true;stop();await Promise.allSettled(tasks);await Promise.allSettled(publications);await Promise.all(stopTasks);await continuousAudio?.close();await continuousMux?.close();await videoMux?.close();await centralExit?.catch(()=>{});
    process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);await rm(temp,{recursive:true,force:true});if(centralDirectory)await rm(centralDirectory,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1});
