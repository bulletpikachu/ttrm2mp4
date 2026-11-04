import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {patchAudioOnlyParticles} from './audio-particles.mjs';

export function patchClient(source,{audioOnlyParticles=false}={}) {
  function replace(needle, replacement) {
    if (source.split(needle).length !== 2) throw Error(`Pinned client patch mismatch: ${needle.slice(0, 80)}`);
    source = source.replace(needle, replacement);
  }
  replace('xt("entry_button").addEventListener("click",(function(e){let t=', 'xt("entry_button").addEventListener("click",(window.__offlineEntryBound=true,function(e){if(window.__offlineMode){yn.login("offline","000000000000000000000000","offline-replay",!1);yn.setRole("anon");document.body.classList.add("anon");xt("entry_form").classList.add("hidden");En.finish();return}let t=');
  replace('const s={get id(){return n.id},get state()', 'const s={get _ctx(){return n},get id(){return n.id},get state()');
  replace('Zl=new o.Application({','window.__nativePixi=o,Zl=new o.Application({');
  replace('window.DEVHOOK_LOAD_REPLAY_RAW=e=>', `window.__native={get games(){return ha},get app(){return Zl},get foreground(){return ec},get pixi(){return window.__nativePixi},get settings(){return ot},get audio(){return La}};window.DEVHOOK_LOAD_REPLAY_RAW=e=>`);
  replace('if(a<=0)return null;const r=e.createBufferSource();r.buffer=b;', 'if(a<=0)return null;if(window.__offlineSfx){const q={buffer:b,offset:o.offset,length:o.len,gain:a,pan:"minimal"!==ot.video.graphics?s:0,rate:"minimal"!==ot.video.graphics?i:1,time:e.currentTime,stop:Infinity};window.__offlineSfx.push(q);const token={};C.set(token,{stop:(t=0)=>{q.stop=Math.min(q.stop,t||e.currentTime)}});return token}const r=e.createBufferSource();r.buffer=b;');
  replace('BgmKill:h,BgmFadeOut:_', '_context:e,BgmKill:h,BgmFadeOut:_');
  replace('async function p(t,l,p){if(o===t)return;', 'function p(...args){const task=__offlinePlayBgm(...args),jobs=window.__offlineBgmJobs??=new Set;jobs.add(task);task.then(()=>jobs.delete(task),()=>jobs.delete(task));return task}async function __offlinePlayBgm(t,l,p){if(o===t)return;');
  replace('await d(t);const u=await e.decodeAudioData(s.get(t).slice(0));','await d(t);const u=window.__offlineDecodedBgm?.get(t)??await e.decodeAudioData(s.get(t).slice(0));');
  replace('BgmLoadFile:d,BgmSetVolume:', 'BgmLoadFile:d,BgmPreloadDecoded:async t=>{await d(t);const buffers=window.__offlineDecodedBgm??=new Map;if(!buffers.has(t))buffers.set(t,await e.decodeAudioData(s.get(t).slice(0)))},BgmSetVolume:');
  replace('i||document.body.classList.contains("banstatus_restrict")||lr.connect()', 'void 0');
  return audioOnlyParticles?patchAudioOnlyParticles(source):source;
}

export async function createLocalClientStore(directory, options={}) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.format !== 1) throw Error('Unsupported local client format. Run npm run prepare-client -- replay.ttrm.');
  const entries = new Map(Object.entries(manifest.entries));
  const byPath = new Map();
  for (const [key, value] of entries) {
    const space = key.indexOf(' '), url = new URL(key.slice(space + 1));
    byPath.set(`${key.slice(0, space)} ${url.origin}${url.pathname}`, value);
  }
  const bodies = new Map(), missing = new Set();
  async function body(entry) {
    if (!bodies.has(entry.hash)) {
      const bytes = await readFile(path.join(directory, 'objects', entry.hash));
      if (createHash('sha256').update(bytes).digest('hex') !== entry.hash) throw Error(`Corrupt local client object ${entry.hash}`);
      bodies.set(entry.hash, bytes);
    }
    return bodies.get(entry.hash);
  }
  return {manifest,missing,async response(method,address){
    const url=new URL(address),key=`${method} ${url.href}`;
    const entry=entries.get(key)||byPath.get(`${method} ${url.origin}${url.pathname}`);
    if(!entry){missing.add(key);return null;}
    let bytes=await body(entry);
    if(url.pathname==='/js/tetrio.js')bytes=Buffer.from(patchClient(bytes.toString('utf8'),options));
    return{status:entry.status,headers:{'content-type':entry.type,'access-control-allow-origin':'*'},body:bytes};
  }};
}

export async function attachLocalClient(context, directory, options={}, electronApp=null) {
  let cache;
  if(electronApp){
    const manifest=await electronApp.evaluate(async(_,config)=>global.__replayInstallLocalClient(config),{directory,options});
    const missing=new Set();
    cache={manifest,missing,transport:'electron-protocol',async refresh(){
      const keys=await electronApp.evaluate(()=>global.__replayLocalClientMissing());
      for(const key of keys)missing.add(key);
    }};
  }else{
    cache=await createLocalClientStore(directory,options);cache.transport='playwright-route';
    await context.route('**/*', async route => {
      const req=route.request(),response=await cache.response(req.method(),req.url());
      if(!response){await route.abort('internetdisconnected');return;}
      await route.fulfill(response);
    });
  }
  await context.routeWebSocket('**/*', ws => ws.close());
  // Stronger than a request allowlist: Chromium's network itself is offline.
  // Cached routes/protocol responses remain available; accidental requests fail.
  await context.setOffline(true);
  return cache;
}
