#!/usr/bin/env node
import { chromium, _electron } from 'playwright-core';
import ffmpeg from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream,constants as fsConstants} from 'node:fs';
import { readFile, writeFile, mkdir, open, mkdtemp, rm, access, rename, link,copyFile } from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {readAppearance} from './offline/appearance.mjs';
import { attachLocalClient } from './offline/client.mjs';
import {createContinuousAudio} from './offline/continuous-audio.mjs';
import {createContinuousMux} from './offline/continuous-mux.mjs';
import {createFFmpegVideo} from './offline/ffmpeg-video.mjs';
import {closeElectron as shutdownElectron} from './offline/electron-shutdown.mjs';
import {validateFrameWindow} from './offline/frame-ranges.mjs';

import {resourcePath,defaultClientDirectory,audioCacheDirectory,electronExecutable,engineEnvironment,emitRenderEvent} from './offline/runtime.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
async function publishFile(source,target){
  try{await rename(source,target)}catch(error){
    if(error.code!=='EXDEV')throw error;
    const staged=path.join(path.dirname(target),`.${path.basename(target)}.${randomUUID()}.partial`);
    try{await copyFile(source,staged,fsConstants.COPYFILE_EXCL);await rename(staged,target)}finally{await rm(staged,{force:true})}
  }
}
async function shareFile(source,target){try{await link(source,target)}catch(error){if(error.code!=='EXDEV')throw error;await copyFile(source,target,fsConstants.COPYFILE_EXCL)}}
const help = `Usage: npm run render-portable -- input.ttrm [output.mp4] [options]

Offline, frame-by-frame export using the pinned native TETR.IO WebGL engine.
First run: npm run prepare-client -- example.ttrm (downloads client/assets once).

  --width N       Even video width (default 1920)
  --height N      Even video height (default 1080)
  --fps N         Output frame rate, integer 1–60 (default 60)
  --round N       Export one round, 1-based (default entire match)
  --export-rounds Save completed rounds with continuous match audio
  --duration N    Export a short preview, including countdown
  --client PATH   Local client directory (default ./client)
  --chrome PATH   Chrome executable (default installed Google Chrome)
  --headed        Show the browser
  --software      Use software WebGL (slower)
  --encoder MODE  auto (default), hardware, software, or ffmpeg (CPU fallback)
  --threads N     FFmpeg fallback threads (default adapts to available CPU cores)
  --direct-io     Electron: write media directly, avoiding browser transfers
  --overwrite     Replace the output file
  --help          Show usage
`;
function number(value, name, max = Infinity, integer = true) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > max || (integer && !Number.isInteger(n))) throw Error(`Invalid ${name}: ${value}`);
  return n;
}
async function runEncoder(video, audio, output, fps, sampleRate,encodedAudio=false,frameCount=0) {
  const index=process.env.REPLAY_RESERVE_MOOV==='1'?['-moov_size',String(Math.max(1048576,Math.ceil(frameCount*64+1048576)))]:['-movflags','+faststart'];
  const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-y',
    '-filter_threads','1',
    '-r', String(fps), '-i', video,...(encodedAudio?[]:['-f', 'f32le', '-ar', String(sampleRate), '-ac', '2']), '-i', audio,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a',encodedAudio?'copy':'aac','-threads','1',...(encodedAudio?[]:['-b:a', '192k']),
    ...index, output], { stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '';
  child.stderr.on('data', data => { errors = (errors + data).slice(-6000); });
  const [code] = await once(child, 'exit');
  if (code !== 0) throw Error(`MP4 mux failed (${code}): ${errors}`);
}
async function main() {
  const wallStart = performance.now();
  const hostTimings={},mark=name=>{hostTimings[name]=(performance.now()-wallStart)/1000};
  const { values: options, positionals } = parseArgs({ allowPositionals: true, options: {
    width: { type: 'string', default: '1920' }, height: { type: 'string', default: '1080' },
    fps: { type: 'string', default: '60' }, round: { type: 'string' }, duration: { type: 'string' },
    appearance: { type: 'string' },
    client: { type: 'string', default: defaultClientDirectory }, chrome: { type: 'string' }, headed: { type: 'boolean' },
    'worker-rounds':{type:'string'}, 'worker-audio':{type:'string'}, 'worker-video-dir':{type:'string'},
    'worker-frames':{type:'string'},
    deterministic:{type:'boolean'},
    threads:{type:'string'},
    'direct-io':{type:'boolean'},
    'native-audio':{type:'boolean'},
    'windows-encoder':{type:'boolean'},
    'quality-interval':{type:'string',default:'2'},
    'quality-inputs-only':{type:'boolean'},
    'render-side':{type:'string'},
    'pbo-encoder':{type:'boolean'},
    'native-encoder': {type:'boolean'}, 'native-webgl': {type:'boolean'}, 'surface-stream': {type:'boolean'}, 'surface-reference': {type:'string'}, 'quality-samples': {type:'string'}, 'surface-encoder': {type:'string'}, 'export-rounds': {type:'boolean'}, 'raw-format': {type:'string',default:'rgba'}, 'raw-encoder': {type:'boolean'}, engine: { type:'string', default:'chrome' }, 'encoder-rate': { type: 'string' }, latency: { type: 'string', default: 'quality' }, encoder: { type: 'string', default: 'auto' }, queue: { type: 'string', default: '8' }, profile: { type: 'string' }, software: { type: 'boolean' }, overwrite: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (options.help) return console.log(help);
  const windowsEncoder=!!options['windows-encoder'];
  const cpuEncoder=!!(options['native-encoder']||options['pbo-encoder']||windowsEncoder);
  const localWebGL=process.env.REPLAY_LOCAL_WEBGL==='1';
  const webglModule=windowsEncoder?path.resolve(here,'../.native-deps/node-webgl-windows/dist/index.js'):localWebGL?path.resolve(here,'../.native-deps/node-webgl-local/dist/index.js'):resourcePath('node_modules/@onirenaud/node-webgl/dist/index.js');
  const angleLibrary=localWebGL?path.resolve(here,'../.native-deps/node-webgl-local/node-webgl-local.node'):resourcePath('node_modules/@onirenaud/node-webgl/prebuilds/darwin-arm64/@onirenaud+node-webgl.node');
  if(localWebGL&&!options['native-webgl'])throw Error('REPLAY_LOCAL_WEBGL requires native-webgl');
  if(process.env.REPLAY_GL_NO_ERROR==='1')throw Error('The no-error context experiment failed the full visual audit. Use the normal render-fast configuration.');
  if(process.env.REPLAY_GL_ASYNC==='1'&&process.env.REPLAY_GL_BATCH!=='1')throw Error('REPLAY_GL_ASYNC requires REPLAY_GL_BATCH=1');
  if(process.env.REPLAY_STREAM_MUX==='1'&&!options['export-rounds'])throw Error('REPLAY_STREAM_MUX requires export-rounds');
  if(options['quality-inputs-only']&&(!(options['native-encoder']||windowsEncoder)||!options['quality-samples']))throw Error('quality-inputs-only requires a native encoder and quality-samples');
  if (!positionals.length || positionals.length > 2) throw Error(help);
  if(!['chrome','electron'].includes(options.engine))throw Error('engine must be chrome or electron');
  if(windowsEncoder&&(process.platform!=='win32'||process.arch!=='x64'||options.engine!=='electron'||!options['native-webgl']||options['native-encoder']||options['pbo-encoder']||options['surface-encoder']||options['raw-encoder']))throw Error('windows-encoder requires Windows x64, Electron, native-webgl, and no other video backend');
  if(windowsEncoder&&process.env.REPLAY_GL_ASYNC==='1'&&process.env.REPLAY_WINDOWS_ASYNC!=='1')throw Error('The Windows GL driver thread requires REPLAY_WINDOWS_ASYNC=1');
  const directIO=!!options['direct-io'];
  if(directIO&&(options.engine!=='electron'||cpuEncoder||options['surface-encoder']||options['raw-encoder']))throw Error('direct-io requires Electron with the browser encoder');
  if(options['native-audio']&&!directIO)throw Error('native-audio requires direct-io');
  if(options['native-webgl']&&options.engine!=='electron')throw Error('native-webgl requires Electron');
  if(options['native-encoder']&&(!options['native-webgl']||options['surface-encoder']||options['raw-encoder']))throw Error('native-encoder requires native-webgl and cannot combine with other encoders');
  if(options['native-encoder']&&(process.platform!=='darwin'||process.arch!=='arm64'))throw Error('The experimental native encoder currently supports Apple Silicon macOS');
  if(options['pbo-encoder']&&(options.engine!=='electron'||options['native-webgl']||options['native-encoder']||options['raw-encoder']||options['surface-encoder']))throw Error('pbo-encoder requires Electron original WebGL and cannot combine with other encoders');
  if(options['pbo-encoder']&&(process.platform!=='darwin'||process.arch!=='arm64'))throw Error('The current PBO codec module supports Apple Silicon macOS');
  if(options['render-side']&&(!options['native-encoder']||!['left','right'].includes(options['render-side'])))throw Error('render-side is a native-encoder diagnostic: left or right');
  if(options['worker-rounds']!==undefined&&(!cpuEncoder||!options['export-rounds']||options.round||options.duration))throw Error('worker-rounds requires a native CPU encoder and export-rounds for the entire timeline');
  if(options['worker-audio']&&options['worker-rounds']===undefined)throw Error('worker-audio is an internal selective-worker option');
  if(options['worker-video-dir']&&options['worker-rounds']===undefined)throw Error('worker-video-dir is an internal selective-worker option');
  if(!['rgba','nv12'].includes(options['raw-format']))throw Error('raw-format must be rgba or nv12');
  if(options['surface-stream']&&options['surface-encoder']!=='cpu')throw Error('surface-stream requires surface-encoder cpu');
  if(options['surface-stream']&&(options['surface-reference']||options['quality-samples']))throw Error('Surface streaming does not yet support reference encoding or quality samples');
  if(options['surface-reference']&&options['surface-encoder']!=='cpu')throw Error('surface-reference requires the CPU surface encoder');
  if(options['surface-encoder']&&!['hardware','cpu'].includes(options['surface-encoder']))throw Error('surface-encoder must be hardware or cpu');
  if(options['surface-encoder']&&options.engine!=='electron')throw Error('surface-encoder requires Electron');
  if(options['surface-encoder']&&(options['export-rounds']||options['raw-encoder']))throw Error('Experimental surface encoding does not yet support progressive rounds or raw-encoder');
  if(options['export-rounds'] && options['raw-encoder'])throw Error('Progressive round export currently requires WebCodecs');
  if(options['raw-encoder'] && options.engine!=='electron')throw Error('raw-encoder requires engine electron');
  if (!['quality','realtime'].includes(options.latency)) throw Error('latency must be quality or realtime');
  if (!['auto','hardware','software','ffmpeg'].includes(options.encoder)) throw Error('encoder must be auto, hardware, software, or ffmpeg');
  const fallbackThreads=options.threads?number(options.threads,'threads',256):undefined;
  const queue = number(options.queue, 'queue', 240);
  const encoderRate = options['encoder-rate'] ? number(options['encoder-rate'], 'encoder-rate', 240) : null;
  const width = number(options.width, 'width', 3840), height = number(options.height, 'height', 2160), fps = number(options.fps, 'fps', 60);
  const qualityInterval=number(options['quality-interval'],'quality interval',Infinity,false);
  if (width % 2 || height % 2) throw Error('Video dimensions must be even.');
  const input = path.resolve(positionals[0]);
  if (!/\.ttrm$/i.test(input)) throw Error('Input must be a .ttrm replay.');
  const replay = JSON.parse(await readFile(input, 'utf8'));
  const rounds = replay.replay?.rounds;
  if (!Array.isArray(rounds) || !rounds.length || rounds.some(r => !Array.isArray(r) || r.length !== 2 || r.some(p => !Number.isFinite(p.replay?.frames) || p.replay.frames <= 0 || !Array.isArray(p.replay.events)))) throw Error('Expected complete two-player multiplayer replay data.');
  const selectedRounds=options['worker-rounds']===undefined?null:options['worker-rounds']==='none'?[]:options['worker-rounds'].split(',').map(value=>number(value,'worker round',rounds.length));
  const videoOnlyWorker=windowsEncoder&&process.env.REPLAY_WORKER_VIDEO_ONLY==='1';
  if(videoOnlyWorker&&(!selectedRounds?.length||!options['worker-video-dir']||options['worker-audio']))throw Error('Video-only workers require selected rounds, shared video storage, and a separate audio leader');
  const frameWindow=options['worker-frames']===undefined?null:validateFrameWindow(JSON.parse(options['worker-frames']));
  if(frameWindow&&(!videoOnlyWorker||!options['export-rounds']))throw Error('Frame windows require a Windows native video-only round worker');
  const deterministic=!!options.deterministic||selectedRounds!==null;
  if(selectedRounds&&new Set(selectedRounds).size!==selectedRounds.length)throw Error('Worker rounds must be unique');
  const round = options.round ? number(options.round, 'round', rounds.length) : null;
  const limitSeconds = options.duration ? number(options.duration, 'duration', Infinity, false) : null;
  const expected = (round ? [rounds[round - 1]] : rounds).reduce((sum, r) => sum + Math.max(...r.map(p => p.replay.frames)) / 60, 0);
  const maxSeconds = Math.ceil(expected + (round ? 1 : rounds.length) * 10 + 30);
  const output = path.resolve(positionals[1] || input.replace(/\.ttrm$/i, '-offline.mp4'));
  if(options.profile&&path.resolve(options.profile)===output.replace(/\.mp4$/i,'.json'))throw Error('Profile and output report must have different paths');
  if (!/\.mp4$/i.test(output)) throw Error('Output must be an MP4.');
  const checkOutput = async () => {
    if (options.overwrite) return;
    for (const target of [output, output.replace(/\.mp4$/i, '.json')]) {
      try { await access(target); throw Error(`Output exists: ${target}. Use --overwrite.`); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  };
  await checkOutput();
  if(options['worker-audio']){const target=path.resolve(options['worker-audio']);if(!options.overwrite){try{await access(target);throw Error('Worker audio exists: '+target)}catch(e){if(e.code!=='ENOENT')throw e}}await mkdir(path.dirname(target),{recursive:true});}
  if(options['worker-video-dir'])await mkdir(path.resolve(options['worker-video-dir']),{recursive:true});
  if(options['surface-reference']){
    const reference=path.resolve(options['surface-reference']);
    if(!options.overwrite){try{await access(reference);throw Error('Reference output exists: '+reference)}catch(e){if(e.code!=='ENOENT')throw e}}
    await mkdir(path.dirname(reference),{recursive:true});
  }
  const roundsDirectory=output.replace(/\.mp4$/i,'-rounds');
  if(options['export-rounds']&&!options.overwrite){try{await access(roundsDirectory);throw Error('Round output directory exists: '+roundsDirectory)}catch(e){if(e.code!=='ENOENT')throw e}}
  const directory = path.resolve(options.client);
  try { await access(path.join(directory, 'manifest.json')); }
  catch { throw Error('Local client is missing. Run npm run prepare-client -- example.ttrm once while online.'); }
  await mkdir(path.dirname(output), { recursive: true });
  // Keep growing raw video/PCM out of cloud-synced destination folders.
  // Completed outputs are published atomically, including across volumes.
  const temp = await mkdtemp(path.join(tmpdir(), 'replay-render-'));
  let browser, video, audio, electronApp, roundVideo, roundAudio,continuousAudio,continuousMux,page;
  const writeVideo=async data=>{await video.write(data);if(roundVideo)await roundVideo.write(data)};
  const fallbackVideo=createFFmpegVideo(ffmpeg,writeVideo,fallbackThreads);
  async function closeElectron(){
    const app=electronApp;if(!app)return;electronApp=null;
    await shutdownElectron(app,windowsEncoder?{mark}:undefined);
  }
  const roundReports=[],roundPublications=[];let roundHash,roundPublicationFailure;
  const interrupt = () => { browser?.close().catch(() => {});electronApp?.process().kill('SIGTERM'); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    emitRenderEvent('stage',{stage:'Loading game files'});
    console.log('Loading pinned native client. Browser networking is disabled.');
    if(options.engine==='electron') {
      const electronBinary=await electronExecutable();
      const engineEntry=path.join(here,options['surface-stream']?'experimental/surface-stream-main.cjs':options['surface-encoder']?'experimental/surface-main.cjs':'experimental/electron-main.cjs');
      electronApp=await _electron.launch({executablePath:electronBinary,args:[path.join(here,options['surface-stream']?'experimental/surface-stream-main.cjs':options['surface-encoder']?'experimental/surface-main.cjs':'experimental/electron-main.cjs')],env:{...engineEnvironment(engineEntry),...(options['surface-encoder']?{REPLAY_SURFACE_CONFIG:JSON.stringify({encoder:options['surface-encoder'],output:path.join(temp,'video.h264'),width,height,fps,reference:options['surface-reference']?path.resolve(options['surface-reference']):null,qualitySamples:options['quality-samples']?path.resolve(options['quality-samples']):null,overwrite:!!options.overwrite})}:{})}});
    }
    else browser = await chromium.launch({
      ...(options.chrome ? { executablePath: options.chrome } : { channel: 'chrome' }), headless: !options.headed,
      args: ['--autoplay-policy=no-user-gesture-required', '--force-color-profile=srgb',
        ...(options.software ? ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] : process.platform === 'darwin' ? ['--use-angle=metal'] : [])],
    });
    mark('launched');
    const context = electronApp ? electronApp.context() : await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'America/Los_Angeles' });
    const audioOnlyParticles=windowsEncoder&&selectedRounds?.length===0&&process.env.REPLAY_WINDOWS_AUDIO_PARTICLES==='1';
    const nativeClient=windowsEncoder&&process.env.REPLAY_WINDOWS_NATIVE_CLIENT==='1';
    const appearance=await readAppearance(options.appearance);
    const cache = await attachLocalClient(context, directory,{audioOnlyParticles,appearance,appearanceFile:options.appearance&&path.resolve(options.appearance)},nativeClient?electronApp:null);
    await context.addInitScript({ content: `localStorage.setItem("feecofScore","1500000");window.__offlineMode=true;window.__audioLength=${Math.min(limitSeconds || maxSeconds, maxSeconds) + 5};` });
    if(deterministic)await context.addInitScript({path:path.join(here,'offline/deterministic.js')});
    if(process.env.REPLAY_GL_BATCH==='1'){
      if(!options['native-encoder']&&!windowsEncoder)throw Error('REPLAY_GL_BATCH requires a native encoder');
      await context.addInitScript({content:`window.__glCommandSchema=${await readFile(path.join(here,'experimental/gl-commands.json'),'utf8')};window.__windowsNativeGLBatch=${windowsEncoder};window.__glBatchModule=${JSON.stringify(windowsEncoder?path.resolve(here,'../.native-deps/windows-gpu/windows-encoder.node'):path.join(here,'experimental/native/angle-surface.node'))};window.__glBatchAngle=${JSON.stringify(angleLibrary)};\n`+(process.env.REPLAY_GL_SPECIALIZE==='1'?await readFile(path.join(here,'experimental/gl-writers.generated.js'),'utf8'):'')+'\n'+await readFile(path.join(here,'experimental/gl-batch.js'),'utf8')});
    }
    if(options['native-webgl'])await context.addInitScript({content:`window.__nativeWebGLModule=${JSON.stringify(webglModule)};\n`+(windowsEncoder&&process.env.REPLAY_WINDOWS_HIGH_QOS==='1'?`if(typeof require==="function")window.__windowsHighQoS=require(${JSON.stringify(path.resolve(here,'../.native-deps/windows-gpu/windows-encoder.node'))}).requestHighQoS();\n`:'')+await readFile(path.join(here,'experimental/native-webgl.js'),'utf8')});
    if(options['surface-stream'])await context.addInitScript({content:`Object.defineProperty(window,'innerHeight',{configurable:true,get:()=>${height}});`});
    await context.addInitScript({ path: path.join(here, 'offline/clock.js') });
    if(process.env.REPLAY_AUDIO_DECODE_CACHE==='1'){
      if(options.engine!=='electron')throw Error('Decoded audio caching requires Electron');
      await context.addInitScript({content:`window.__audioDecodeCacheDirectory=${JSON.stringify(audioCacheDirectory)};\n`+await readFile(path.join(here,'offline/audio-decode-cache.js'),'utf8')});
    }
    if(options['export-rounds'])await context.addInitScript({content:(await readFile(path.join(here,'offline/audio-graph.js'),'utf8'))+'\n'+(await readFile(path.join(here,'offline/audio.js'),'utf8'))});
    else await context.addInitScript({ path: path.join(here, 'offline/audio.js') });
    page = electronApp ? await electronApp.firstWindow() : await context.newPage();
    await page.setViewportSize({width,height:height+(options['surface-stream']?8:0)});page.setDefaultTimeout(60000);
    const clientErrors = [];
    let rejectStartup;const startupFailure=new Promise((_,reject)=>{rejectStartup=reject});startupFailure.catch(()=>{});
    page.on('pageerror', e => { clientErrors.push(e.stack || e.message);if(process.env.REPLAY_GL_BATCH==='1'||windowsEncoder){console.error('Experimental renderer error: '+(e.stack||e.message));rejectStartup(e)} });
    await page.goto('https://tetr.io/', { waitUntil: 'domcontentloaded' });
    mark('pageLoaded');
    await Promise.race([page.waitForFunction(()=>window.__native||window.__offlineEntryBound),startupFailure]);
    if(!await page.evaluate(()=>!!window.__native))await page.evaluate(()=>document.getElementById('entry_button').click());
    if(process.env.REPLAY_EARLY_MUSIC==='1'){
      await Promise.race([page.waitForFunction(()=>window.__native&&window.opusResult),startupFailure]);
      await page.evaluate(()=>{window.__offlineEarlyMusic=__native.audio.BgmPreloadDecoded('shiroi-hyoutan');window.__offlineEarlyMusic.catch(()=>{});});
    }
    await Promise.race([page.waitForFunction(() => window.__native && document.getElementById('preload')?.classList.contains('ready')),startupFailure]);
    await page.evaluate(() => document.fonts.ready);
    if(process.env.REPLAY_AUDIO_DECODE_CACHE==='1')await page.evaluate(()=>{if(window.__audioDecodeCacheFailure)throw Error(window.__audioDecodeCacheFailure)});
    if(process.env.REPLAY_GL_BATCH==='1'&&!await page.evaluate(()=>window.__glBatchMetrics?.calls>0))throw Error('Native GL batching did not initialize');
    mark('clientReady');
    if(windowsEncoder&&process.env.REPLAY_WINDOWS_HIGH_QOS==='1')await page.evaluate(()=>{
      const request=window.__windowsHighQoS;
      if(!request||(request.requestedControlMask&1)!==1||(request.requestedStateMask&1)!==0)throw Error('Windows renderer did not request performance QoS');
    });
    if(windowsEncoder&&process.env.REPLAY_WINDOWS_SHADER_CACHE)await page.evaluate(()=>{
      const cache=window.__nativeWebGLContext(__native.app.view)?._n._replayShaderCacheStats?.();
      if(!cache?.enabled)throw Error('Shader caching requires rebuilding the local Windows WebGL binding');
    });
    // A local file does not need the online replay-ID existence check.
    replay.id = null;
    await page.evaluate(raw => {
      const dt = new DataTransfer();dt.items.add(new File([raw], 'input.ttrm', { type: 'application/json' }));
      document.getElementById('menus').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    }, JSON.stringify(replay));
    await page.locator('#multilog .multilog_result').first().waitFor({ state: 'visible' });
    if (await page.locator('#multilog .multilog_result').count() !== rounds.length) throw Error('Native client did not import every round.');
    mark('replayImported');
    await page.evaluate(async()=>{
      // Decode music before advancing virtual time. File prefetch alone leaves
      // native decode completion and normalization gain dependent on CPU speed.
      if(window.__offlineEarlyMusic)await window.__offlineEarlyMusic;
      else await __native.audio.BgmPreloadDecoded('shiroi-hyoutan');
      while(window.__offlineBgmJobs?.size)await Promise.all([...window.__offlineBgmJobs]);
    });
    mark('musicDecoded');
    if(process.env.REPLAY_WAIT_TEXTURES==='1'){
      await page.evaluate(async()=>{
        const textures=Object.values(__native.pixi.utils.BaseTextureCache);
        await Promise.all(textures.filter(texture=>texture.resource?.source instanceof HTMLImageElement).map(texture=>texture.resource.load()));
      });
      mark('texturesDecoded');
    }
    await page.evaluate(async({ round,deterministic }) => {
      window.__native.audio.BgmKill();
      window.__offlineSfx.length = 0;
      window.__timeline.freeze({deterministic});
      if(deterministic)for(const ticker of new Set([__native.app.ticker,__native.pixi.Ticker.shared,__native.pixi.Ticker.system])){ticker.lastTime=__timeline.time;ticker._lastFrame=__timeline.time;}
      if(deterministic){
        // Finish the already-loaded menu's visual fade using virtual time;
        // real loading speed should not decide the first replay frame opacity.
        for(let frame=0;frame<90;frame++){__timeline.step(1000/60);for(let settle=0;settle<16;settle++)await Promise.resolve()}
        if(typeof process!=='undefined'&&process.env.REPLAY_WAIT_TEXTURES==='1'){
          // Seed the export from a completed menu draw. A texture can be ready
          // before the real-time ticker has drawn it into the old MSAA buffer.
          __replayRandom.drawFrame(-1,()=>__native.app.renderer.render(__native.app.stage));
          window.__nativeWebGLContext?.(__native.app.view)?.finish();
        }
        __timeline.restartOrigin();__offlineSfx.length=0;
      }
      document.querySelectorAll('#multilog .multilog_result')[(round || 1) - 1].click();
      document.getElementById(round ? 'replaytools_button_end' : 'replaytools_button_nextround').click();
    }, { round,deterministic });
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    video = await open(path.join(temp, 'video.h264'), 'wx');audio = await open(path.join(temp, 'audio.f32'), 'wx');
    await page.exposeBinding('__writeVideo', async (_, bytes) => writeVideo(Buffer.from(bytes,'base64')));
    await page.exposeBinding('__startFFmpegVideo',(_,settings)=>fallbackVideo.start(settings));
    await page.exposeBinding('__writeRawVideo',(_,bytes)=>fallbackVideo.write(Buffer.from(bytes,'base64')));
    await page.exposeBinding('__finishFFmpegVideo',()=>fallbackVideo.finish());
    await page.exposeBinding('__writeAudio', async (_, bytes) => { await audio.write(Buffer.from(bytes, 'base64')); });
    if(options['export-rounds']){
      await mkdir(roundsDirectory,{recursive:true});
      await page.exposeBinding('__beginRound',async(_,data)=>{
        if(roundPublicationFailure)throw roundPublicationFailure;
        roundVideo=await open(path.join(temp,'round.h264'),'w');roundAudio=await open(path.join(temp,'round.f32'),'w');roundHash=createHash('sha256');
      });
      await page.exposeBinding('__writeRoundAudio',async(_,bytes)=>{const data=Buffer.from(bytes,'base64');roundHash.update(data);await roundAudio.write(data)});
      await page.exposeBinding('__finishRound',async(_,data)=>{
        await roundVideo?.close();roundVideo=null;await roundAudio.close();roundAudio=null;
        const pcmSha256=videoOnlyWorker?null:cpuEncoder||directIO?createHash('sha256').update(await readFile(path.join(temp,'round.f32'))).digest('hex'):roundHash.digest('hex');
        const name=`round-${String(data.round).padStart(2,'0')}${data.partial?'-partial':''}.mp4`;
        const target=path.join(roundsDirectory,name),stem=path.join(temp,`round-${data.round}`),staged=stem+'.mp4';
        await rename(path.join(temp,'round.h264'),stem+'.h264');await rename(path.join(temp,'round.f32'),stem+'.f32');
        if(selectedRounds===null&&process.env.REPLAY_STREAM_MUX==='1'){
          continuousMux??=createContinuousMux(ffmpeg,path.join(temp,'movie.mp4'),fps,data.sampleRate,maxSeconds*fps);
          continuousMux.append(stem+'.h264',stem+'.f32',data);
        }else if(selectedRounds===null&&process.env.REPLAY_STREAM_AUDIO==='1'){
          continuousAudio??=createContinuousAudio(ffmpeg,path.join(temp,'master.m4a'),data.sampleRate);
          continuousAudio.append(stem+'.f32',data);
        }
        if(options['worker-video-dir']){
          const shared=path.resolve(options['worker-video-dir']);
          await shareFile(stem+'.h264',path.join(shared,frameWindow?`fragment-${data.round}-${data.startFrame}-${data.endFrame}.h264`:`round-${data.round}.h264`));
          if(!videoOnlyWorker)await shareFile(stem+'.f32',path.join(shared,`round-${data.round}.f32`));
        }
        const report={...data,pcmSha256,path:videoOnlyWorker?null:target,publishedSeconds:null};roundReports.push(report);
        if(videoOnlyWorker){if(process.connected)process.send({type:frameWindow?'video-fragment':'video-round',report});return;}
        const publication=(async()=>{
          await runEncoder(stem+'.h264',stem+'.f32',staged,fps,data.sampleRate,false,data.endFrame-data.startFrame);await publishFile(staged,target);
          report.publishedSeconds=(performance.now()-wallStart)/1000;
          emitRenderEvent('round',{round:data.round,path:target,partial:data.partial});
          console.log(`Round ${data.round}${data.partial?' preview':''} saved: ${target}`);
          if(process.connected)process.send({type:'round',report});
        })().catch(error=>{roundPublicationFailure??=error});
        roundPublications.push(publication);
      });
    }
    if(options['quality-samples']&&!options['surface-encoder']){
      const samplesDirectory=path.resolve(options['quality-samples']);await mkdir(samplesDirectory,{recursive:true});
      await page.exposeBinding('__qualitySample',async(_,index,data)=>{await writeFile(path.join(samplesDirectory,`frame-${String(index).padStart(6,'0')}.png`),Buffer.from(data,'base64'),{flag:options.overwrite?'w':'wx'})});
    }
    let previousRound;
    await page.exposeBinding('__renderProgress', (_, data) => {
      emitRenderEvent('progress',{...data,totalSeconds:limitSeconds?Math.min(expected,limitSeconds):expected,roundCount:rounds.length});
      if (data.stage) { console.log(`${((performance.now() - exportStart) / 1000).toFixed(2)}s: ${data.stage}`); return; }
      if (data.round !== previousRound) { console.log(`Rendering round ${data.round || round || 1} / ${rounds.length}…`); previousRound = data.round; }
    });
    if(options['surface-encoder'])await page.addScriptTag({path:path.join(here,options['surface-stream']?'experimental/surface-stream-renderer.js':'experimental/surface-renderer.js')});
    if(options['raw-encoder']){
      await page.evaluate(settings=>{window.__rawEncoderOptions=settings},{ffmpeg,format:options['raw-format'],output:path.join(temp,'video.h264')});
      if(options['raw-format']==='nv12')await page.addScriptTag({path:path.join(here,'experimental/nv12.js')});
      await page.addScriptTag({path:path.join(here,'experimental/raw-encoder.js')});
    }
    if(cpuEncoder){
      await page.exposeBinding('__commitNativeSegment',async()=>{
        const source=path.join(temp,'native-segment.h264');
        if(selectedRounds===null&&process.env.REPLAY_STREAM_MUX!=='1')await video.write(await readFile(source));
        if(roundVideo){await roundVideo.close();roundVideo=null;await rename(source,path.join(temp,'round.h264'));}
      });
      await page.evaluate(settings=>window.__nativeEncoderOptions=settings,{output:path.join(temp,'native-segment.h264'),audio:path.join(temp,'audio.f32'),roundAudio:path.join(temp,'round.f32'),qualitySamples:options['quality-samples']?path.resolve(options['quality-samples']):null,qualityInputsOnly:!!options['quality-inputs-only'],overwrite:!!options.overwrite,directory:path.join(here,'experimental/native'),angle:angleLibrary,windowsCodec:windowsEncoder?path.resolve(here,'../.native-deps/windows-gpu/windows-encoder.node'):null});
      await page.addScriptTag({path:path.join(here,'experimental/native-audio.js')});
      if(process.env.REPLAY_CENTRAL_ENCODER)await page.addScriptTag({path:path.join(here,'experimental/central-encoder-client.js')});
      if(options['pbo-encoder']){await page.addScriptTag({path:path.join(here,'experimental/nv12.js')});await page.addScriptTag({path:path.join(here,'experimental/nv12-workers.js')});}
      await page.addScriptTag({path:path.join(here,windowsEncoder?'experimental/windows-encoder.js':options['pbo-encoder']?'experimental/pbo-encoder.js':'experimental/native-encoder.js')});
    }
    if(directIO){
      await page.evaluate(settings=>window.__directIOOptions=settings,{video:path.join(temp,'video.h264'),audio:path.join(temp,'audio.f32'),roundVideo:path.join(temp,'round.h264'),roundAudio:path.join(temp,'round.f32')});
      await page.addScriptTag({path:path.join(here,'offline/direct-io.js')});
      if(options['native-audio']){
        await page.addScriptTag({path:path.join(here,'experimental/native-audio.js')});
        await page.evaluate(settings=>{delete window.__writeNativeAudio;window.__installNativeAudio(settings)},{directory:path.join(here,'experimental/native'),audio:path.join(temp,'audio.f32'),roundAudio:path.join(temp,'round.f32')});
      }
    }
    await page.addScriptTag({ path: path.join(here, 'offline/video-encoder.js') });
    await page.addScriptTag({ path: path.join(here, 'offline/export.js') });
    if(options['render-side']){await page.evaluate(side=>window.__renderBoardSide=side,options['render-side']);await page.addScriptTag({path:path.join(here,'experimental/spatial-mask.js')});}
    const profiler = options.profile ? await context.newCDPSession(page) : null;
    if (profiler) { await profiler.send("Profiler.enable"); await profiler.send("Profiler.start"); }
    const exportStart = performance.now();
    mark('exportStarted');
    if(options['native-webgl'])await page.evaluate(()=>{window.__exportCPUStart=process.cpuUsage()});
    const result = await page.evaluate(options => __exportMovie(options), { fps, width, height, limitSeconds, maxSeconds, roundCount: rounds.length, queue, encoderMode: options.encoder, latencyMode: options.latency, encoderRate, selectedRounds, deterministic,qualityInterval,videoOnlyWorker,frameWindow,stopAfterSelected:windowsEncoder&&process.env.REPLAY_WORKER_PREFIX==='1',roundFrameLimits:rounds.map(round=>Math.max(...round.map(player=>player.replay.frames))) });
    result.graphicsPreset=await page.evaluate(()=>window.__native.settings.video.graphics);
    if (appearance) {
      result.appearance={
        video:await page.evaluate(keys=>Object.fromEntries(keys.map(key=>[key,window.__native.settings.video[key]])),Object.keys(appearance.video)),
      };
    }
    if(audioOnlyParticles&&(!result.audioOnly||result.audioOnlyParticleUpdates?.enabled!==true))throw Error('Audio-only particle optimization was not installed');
    if(!audioOnlyParticles&&result.audioOnlyParticleUpdates)throw Error('Audio-only particle optimization reached a drawing worker');
    if(process.env.REPLAY_AUDIO_DECODE_CACHE==='1')result.audioDecodeCache=await page.evaluate(()=>{if(window.__audioDecodeCacheFailure)throw Error(window.__audioDecodeCacheFailure);return window.__audioDecodeCacheMetrics});
    if(options['render-side'])result.diagnosticBoardSide=options['render-side'];
    result.pipeline=options['pbo-encoder']?'chromium-webgl-pbo-x264':options['native-encoder']?'native-angle-iosurface-x264':options['surface-encoder']?'electron-surface-'+options['surface-encoder']:options['raw-encoder']?'electron-ffmpeg-'+options['raw-format']:'webcodecs';
    if(directIO)result.pipeline='electron-webcodecs-direct';
    if(windowsEncoder)result.pipeline='native-angle-d3d11-nvenc';
    if(result.videoEncoding?.backend==='ffmpeg'){
      result.pipeline='chromium-webgl-ffmpeg-x264';
      Object.assign(result.videoEncoding,{threads:fallbackVideo.threads,codec:'libx264',preset:'ultrafast',crf:18});
    }
    if(cpuEncoder)result.encoderMode=result.audioOnly?'none':windowsEncoder?'native-nvenc':'native-x264';
    if(options['pbo-encoder'])result.pbo=await page.evaluate(()=>window.__pboEncoderResult);
    if(options['surface-encoder'])result.surface=await page.evaluate(()=>window.__surfaceResult);
    if(options['native-webgl'])result.nativeWebGL=await page.evaluate(()=>({contexts:window.__nativeWebGLContexts?.length,version:window.__nativeWebGLContext(__native.app.view)?.getParameter(7938),encoder:window.__nativeEncoderResult,glMetrics:window.__nativeGLMetrics,numberFormat:window.__numberFormatMetrics,highQoS:window.__windowsHighQoS,shaderCache:process.platform==="win32"?window.__nativeWebGLContext(__native.app.view)?._n._replayShaderCacheStats?.():undefined,metalProbe:window.__nativeMetalProbe,localBinding:process.env.REPLAY_LOCAL_WEBGL==='1',noErrorContexts:window.__nativeNoErrorContexts||[],cpuTime:process.cpuUsage(window.__exportCPUStart),v8Flags:process.env.REPLAY_V8_FLAGS||null,chromiumSoftware:process.env.REPLAY_CHROMIUM_SOFTWARE==='1',batch:window.__glBatchMetrics,thread:window.__nativeGLThreadStats?.()}));
    await Promise.all(roundPublications);if(roundPublicationFailure)throw roundPublicationFailure;
    if(process.env.REPLAY_GL_BATCH==='1'&&clientErrors.length)throw Error('Experimental renderer had client errors: '+clientErrors.join('\n'));
    if (profiler) { const {profile} = await profiler.send("Profiler.stop"); await writeFile(path.resolve(options.profile), JSON.stringify(profile)); }
    await video.close();video = null;await audio.close();audio = null;
    const audioHash=createHash('sha256');let audioBytes=0;for await(const bytes of createReadStream(path.join(temp,'audio.f32'))){audioHash.update(bytes);audioBytes+=bytes.length;}
    const audioPCMHash=videoOnlyWorker?null:audioHash.digest('hex');if(videoOnlyWorker&&audioBytes)throw Error('Video-only worker unexpectedly wrote master audio');if(result.audioPCMHash&&result.audioPCMHash!==audioPCMHash)throw Error('Written PCM differs from the native mixer output');result.audioPCMHash=audioPCMHash;
    if(continuousAudio)result.continuousAudio=await continuousAudio.finish(audioPCMHash,result.samples*8);
    if(continuousMux)result.continuousMux=await continuousMux.finish(audioPCMHash,result.samples*8,result.count);
    if(options['export-rounds']&&!videoOnlyWorker){
      const pcm=await open(path.join(temp,'audio.f32'),'r');
      try{
        const bytes=Buffer.alloc(262144);
        for(const report of roundReports){
          let position=Math.round(report.startFrame/fps*report.sampleRate)*8;
          const end=Math.round(report.endFrame/fps*report.sampleRate)*8,hash=createHash('sha256');
          while(position<end){const {bytesRead}=await pcm.read(bytes,0,Math.min(bytes.length,end-position),position);if(!bytesRead)throw Error('Master audio ended before round boundary');hash.update(bytes.subarray(0,bytesRead));position+=bytesRead}
          report.pcmMatchesMaster=hash.digest('hex')===report.pcmSha256;
          if(!report.pcmMatchesMaster)throw Error(`Round ${report.round} audio differs from the continuous master`);
        }
      }finally{await pcm.close()}
    }
    const renderSeconds = (performance.now() - exportStart) / 1000;
    mark('exportVerified');
    await cache.refresh?.();
    if(appearance)result.appearance.assets=[...cache.appearanceUsed].sort();
    const missingAssets = [...cache.missing].filter(key => /https:\/\/tetr\.io\/res\//.test(key) && !/\/res\/supporter-perk-/.test(key));
    if (missingAssets.length) throw Error(`Offline assets missing. Refresh the local client:\n${missingAssets.join('\n')}`);
    let audioSourcePublished=false;
    if(windowsEncoder&&options['worker-audio']&&process.env.REPLAY_EARLY_AUDIO==='1'){
      await publishFile(path.join(temp,'audio.f32'),path.resolve(options['worker-audio']));audioSourcePublished=true;mark('audioSourcePublished');
      if(process.connected){
        const report={input,output:null,workerAudio:path.resolve(options['worker-audio']),clientVersion:cache.manifest.hardVersion,networkingDisabled:true,width,height,fps,rounds:roundReports,...result,renderSeconds,hostTimings:{...hostTimings},elapsedSeconds:(performance.now()-wallStart)/1000,missingAssets,clientErrors};
        report.localClientTransport=cache.transport;
        await new Promise((resolve,reject)=>process.send({type:'audio-ready',report},error=>error?reject(error):resolve()));
      }
    }
    await closeElectron();
    await browser?.close();browser = null;
    mark('browserClosed');
    if(selectedRounds===null){
      if(!continuousMux)await runEncoder(path.join(temp, 'video.h264'), path.join(temp,continuousAudio?'master.m4a':'audio.f32'), path.join(temp, 'movie.mp4'), fps, result.sampleRate,!!continuousAudio,result.count);
      await checkOutput();await publishFile(path.join(temp, 'movie.mp4'), output);
    }
    if(options['worker-audio']&&!audioSourcePublished)await publishFile(path.join(temp,'audio.f32'),path.resolve(options['worker-audio']));
    const elapsedSeconds = (performance.now() - wallStart) / 1000;
    const report = { input, output:selectedRounds===null?output:null, workerAudio:options['worker-audio']?path.resolve(options['worker-audio']):null, clientVersion: cache.manifest.hardVersion, networkingDisabled: true, width, height, fps, rounds:roundReports, ...result, renderSeconds, elapsedSeconds, hostTimings, speedup: result.duration / elapsedSeconds, renderSpeedup: result.duration / renderSeconds, missingAssets, clientErrors };
    report.localClientTransport=cache.transport;
    await writeFile(output.replace(/\.mp4$/i, '.json'), JSON.stringify(report, null, 2) + '\n');
    if(selectedRounds===null)emitRenderEvent('completed',{output,report:output.replace(/\.mp4$/i,'.json')});
    if(selectedRounds!==null)console.log(`Worker finished ${result.duration.toFixed(2)}s timeline and ${result.encodedCount} selected frames in ${elapsedSeconds.toFixed(2)}s. No full video was produced by this worker.`);
    else console.log(`Saved ${output}${options['render-side']?' (diagnostic partial-board output; not a complete game export)':''}\n${result.duration.toFixed(2)}s video in ${elapsedSeconds.toFixed(2)}s total (${report.speedup.toFixed(2)}× real time; rendering ${report.renderSpeedup.toFixed(2)}×).`);
  } finally {
    if(windowsEncoder&&page)await page.evaluate(()=>window.__shutdownWindowsEncoder?.()).catch(()=>{});
    await fallbackVideo.close().catch(()=>{});
    await continuousAudio?.close().catch(()=>{});
    await continuousMux?.close().catch(()=>{});
    await closeElectron().catch(()=>{});
    await browser?.close().catch(() => {});await video?.close().catch(() => {});await audio?.close().catch(() => {});
    await roundVideo?.close().catch(()=>{});await roundAudio?.close().catch(()=>{});
    await Promise.all(roundPublications);
    await rm(temp, { recursive: true, force: true });process.removeListener('SIGINT', interrupt);process.removeListener('SIGTERM', interrupt);
  }
}
main().catch(e => { emitRenderEvent('error',{message:e.message});console.error(`Error: ${e.stack || e.message}`);process.exitCode = 1; }).finally(()=>{if(process.connected)process.disconnect()});
