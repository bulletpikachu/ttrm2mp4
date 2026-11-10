#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {access,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hostResources,resourceDefaults,positiveInteger,extractOptions,optionValue,selectBackend,probeWorkerCount,windowsFastEnvironment} from './offline/render-policy.mjs';
import {terminateWindowsProcessTree} from './offline/windows-process-tree.mjs';
import {readReplay,replayExtension} from './offline/replay.mjs';

import {resourceRoot,defaultClientDirectory,emitRenderEvent,forwardRenderEvents,portableEnvironment} from './offline/runtime.mjs';
const root=resourceRoot;
async function run(script,args,{env=process.env,probe=false,executable}={}) {
  const child=spawn(executable??process.execPath,executable?args:[path.join(root,script),...args],{env,stdio:probe?['ignore','ignore','pipe']:['inherit','inherit','inherit','ipc'],windowsHide:true});
  if(!probe)forwardRenderEvents(child);
  let errors='',cancelled=false,cleanup;
  child.stderr?.on('data',data=>{errors=(errors+data).slice(0,12000)});
  const stop=()=>{
    cancelled=true;
    cleanup??=process.platform==='win32'?terminateWindowsProcessTree(child):Promise.resolve(child.kill('SIGTERM'));
    cleanup.catch(()=>{});
  };
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  let timedOut=false;
  const timer=probe?setTimeout(()=>{timedOut=true;stop()},60000):null;
  try {
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)});
    if(timedOut)throw Error('Native startup check timed out');
    if(cancelled){const error=Error('Render cancelled');error.cancelled=true;throw error;}
    if(code!==0)throw Error(errors.split('\n').find(line=>/^(?:Error|[A-Za-z]+Error):/.test(line))||errors.trim().slice(-600)||`${script} exited with code ${code}`);
  }finally{
    clearTimeout(timer);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
    await cleanup;
  }
}
async function main(){
  const raw=process.argv.slice(2);
  if(raw.includes('--help'))return console.log(`Usage: npm run render -- input.ttr|input.ttrm [output.mp4] [options]

Automatically select a prepared native backend, or the portable Chrome renderer.
  --backend MODE  auto (default), portable, mac, windows-nvidia
  --jobs N        Drawing workers (automatic CPU/memory default, Windows native only)
  --threads N     CPU encoding threads (automatic default; Mac or portable only)
  --width N --height N --fps N --client PATH --overwrite
  --rounds LIST   Export selected multiplayer rounds, e.g. 1,3,5
  --report        Write a JSON diagnostic report beside the MP4
  --duration N / --round N use the portable path on Windows.
Native startup is checked with a temporary short export before selecting it.
Use npm run render-portable -- --help for all portable renderer options.`);
  const {values,args}=extractOptions(raw,['backend','jobs','threads']);
  const requested=values.backend??'auto';
  const width=positiveInteger(optionValue(args,'width','1920'),'width',3840);
  const height=positiveInteger(optionValue(args,'height','1080'),'height',2160);
  if(width%2||height%2)throw Error('Video dimensions must be even');
  positiveInteger(optionValue(args,'fps','60'),'fps',60);
  const defaults=resourceDefaults(hostResources(),width,height);
  let jobs=values.jobs===undefined?defaults.jobs:positiveInteger(values.jobs,'jobs',8);
  const threads=values.threads===undefined?undefined:positiveInteger(values.threads,'threads',256);
  const appearance=optionValue(args,'appearance');
  const roundList=optionValue(args,'rounds');
  // Locate input/output with the renderer's public option schema; unknown options
  // stay intact and are diagnosed by the selected renderer.
  const valueOptions=new Set(['width','height','fps','client','appearance','duration','round','rounds','chrome','encoder','queue','latency','profile','quality-samples','quality-interval','encoder-rate','engine','raw-format','surface-encoder','surface-reference','render-side','worker-rounds','worker-audio','worker-video-dir','worker-frames']);
  const positionals=[];
  for(let i=0;i<args.length;i++){
    const arg=args[i];
    if(arg==='--'){positionals.push(...args.slice(i+1));break;}
    if(arg.startsWith('--')){if(!arg.includes('=')&&valueOptions.has(arg.slice(2)))i++;continue;}
    positionals.push(arg);
  }
  if(positionals.length<1||positionals.length>2)throw Error('Provide a .ttr or .ttrm replay and an optional output.mp4. Use --help for usage.');
  // Validate the input before probing, so input errors never look like GPU failures.
  const {roundNumbers}=await readReplay(positionals[0],roundList);
  let nativeThreads=threads??defaults.nativeThreads;
  const selection=await selectBackend({requested,platform:process.platform,arch:process.arch,args,threadsRequested:threads!==undefined,probe:async backend=>{
    if(backend==='mac'&&threads===undefined&&process.env.REPLAY_X264_THREADS!==undefined)nativeThreads=positiveInteger(process.env.REPLAY_X264_THREADS,'REPLAY_X264_THREADS',32);
    if(backend==='mac'&&nativeThreads>32)throw Error('Mac native encoding supports at most 32 threads');
    const modules=backend==='mac'?['src/experimental/native/angle-surface.node','src/experimental/native/x264-surface-encoder.node','src/experimental/native/audio-mixer.node','desktop/worker.cjs']:['src/experimental/native/audio-mixer.node','.native-deps/node-webgl-windows/dist/index.js','.native-deps/windows-gpu/windows-encoder.node','desktop/worker.cjs'];
    for(const name of modules)try{await access(path.join(root,name));}catch{throw Error(`Missing native dependency: ${name}. Run ${backend==='mac'?'prepare-fast':'prepare-windows-fast'} first.`);}
    emitRenderEvent('stage',{stage:'Checking rendering support'});
    console.log(`Checking ${backend} rendering support…`);
    const temporary=await mkdtemp(path.join(tmpdir(),'replay-backend-check-'));
    try{
      const dimensions=['--width',String(width),'--height',String(height),'--fps',optionValue(args,'fps','60'),'--client',optionValue(args,'client',defaultClientDirectory)];
      const preview=[path.resolve(positionals[0]),path.join(temporary,'check.mp4'),...dimensions,...(appearance?['--appearance',appearance]:[]),...(roundNumbers?['--rounds',roundNumbers.join(',')]:[]),'--duration','0.1'];
      if(backend==='mac')await run('src/render-fast.mjs',[...preview,'--threads',String(nativeThreads)],{probe:true});
      else{
        if(roundNumbers)jobs=Math.min(jobs,roundNumbers.length);
        const env={...windowsFastEnvironment(),REPLAY_GL_BATCH:'1',REPLAY_GL_ASYNC:'1',REPLAY_WINDOWS_ASYNC:'1',REPLAY_WINDOWS_FENCE:'1',REPLAY_WINDOWS_NV12:'1'};
        // Verify that a single renderer works before testing concurrent sessions.
        await run('src/render.mjs',[...preview,'--engine','electron','--native-webgl','--windows-encoder','--export-rounds','--deterministic'],
          {probe:true,env});
        // Check simultaneous NVENC sessions at the proposed concurrency. Older
        // drivers or other running encoders may leave fewer sessions available.
        jobs=await probeWorkerCount({jobs,explicit:values.jobs!==undefined,
          onRetry:count=>console.log(`Retrying native startup with ${count} drawing worker(s)…`),
          probeGroup:count=>run('scripts/probe-render-windows.mjs',
            ['--group',String(count),String(width),String(height),optionValue(args,'fps','60'),temporary],
            {probe:true,env}),
        });
        // The fast Windows pipeline also requires Media Foundation AAC.
        const {default:ffmpeg}=await import('ffmpeg-static');
        await run(null,['-hide_banner','-loglevel','error','-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-t','0.1','-af','apad=pad_len=2048,asetnsamples=n=2048:p=1','-c:a','aac_mf','-threads','1','-b:a','192k',path.join(temporary,'check.m4a')],{probe:true,executable:ffmpeg});
      }
    }finally{await rm(temporary,{recursive:true,force:true});}
  }});
  emitRenderEvent('backend',{backend:selection.backend,reason:selection.reason});
  console.log(`Renderer: ${selection.backend}. ${selection.reason}`);
  if(selection.backend==='windows-nvidia'){
    if(threads!==undefined)throw Error('--threads applies to CPU encoding; Windows NVENC uses --jobs instead');
    const output=positionals[1]??path.resolve(positionals[0]).replace(replayExtension,'-offline.mp4');
    console.log(`Using ${jobs} drawing worker(s), plus one audio worker.`);
    await run('src/render-windows-fast.mjs',[...args.filter(arg=>!['--export-rounds','--deterministic'].includes(arg)),...(positionals[1]?[]:[output]),'--jobs',String(jobs)]);
  }else if(selection.backend==='mac'){
    if(values.jobs!==undefined&&jobs!==1)throw Error('Mac fast rendering uses one continuous drawing worker');
    console.log(`Using one drawing worker and ${nativeThreads} encoder thread(s).`);
    await run('src/render-fast.mjs',[...args,'--threads',String(nativeThreads)]);
  }else{
    if(values.jobs!==undefined)throw Error('Portable rendering uses one drawing worker; remove --jobs');
    const count=threads??defaults.portableThreads;
    console.log(`Using one drawing worker; CPU encoder fallback capped at ${count} thread(s).`);
    await run('src/render.mjs',['--threads',String(count),'--export-rounds','--deterministic',...(process.env.REPLAY_DESKTOP==='1'?['--engine','electron']:[]),...args],{env:portableEnvironment()});
  }
}
main().catch(error=>{emitRenderEvent('error',{message:error.message});console.error(error.message);process.exitCode=1;});

process.once('beforeExit',()=>{if(process.connected)process.disconnect()});
