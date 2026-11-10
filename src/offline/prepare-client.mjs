import {chromium,_electron} from 'playwright-core';
import {mkdir,readFile,writeFile,rename,rm,mkdtemp} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {importReplay,patchClient} from './client.mjs';
import {readReplay} from './replay.mjs';
import {electronExecutable,engineEnvironment,resourcePath} from './runtime.mjs';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const allowed=address=>{try{return /(^|\.)tetr\.io$/.test(new URL(address).hostname);}catch{return false;}};
export async function validatePreparedClient(directory,{verifyPatch=true}={}){
  const manifest=JSON.parse(await readFile(path.join(directory,'manifest.json'),'utf8'));
  if(manifest.format!==1||!manifest.entries||typeof manifest.game!=='string'||!manifest.entries[manifest.game]||!manifest.entries['GET https://tetr.io/'])throw Error('Incomplete TETR.IO game files');
  const checked=new Set();
  for(const [key,entry]of Object.entries(manifest.entries)){
    if(!key.startsWith('GET ')||!allowed(key.slice(4))||!/^[a-f0-9]{64}$/.test(entry.hash)||entry.status!==200)throw Error('Invalid game-file manifest entry');
    if(checked.has(entry.hash))continue;
    const body=await readFile(path.join(directory,'objects',entry.hash));
    if(digest(body)!==entry.hash)throw Error('Downloaded game file failed its integrity check');
    checked.add(entry.hash);
  }
  if(verifyPatch)patchClient(await readFile(path.join(directory,'objects',manifest.entries[manifest.game].hash),'utf8'));
  return manifest;
}
export async function publishPreparedClient(staging,directory){
  const backup=directory+'.backup-'+randomUUID();let moved=false,published=false;
  try{
    try{await rename(directory,backup);moved=true;}catch(error){if(error.code!=='ENOENT')throw error;}
    try{await rename(staging,directory);published=true;}catch(error){if(moved)await rename(backup,directory);throw error;}
  }finally{if(moved&&published)await rm(backup,{recursive:true,force:true});}
}
export async function prepareClient({replayPath,directory,engine='electron',chrome,software=false,signal,onProgress=()=>{}}){
  const replayInput=await readReplay(replayPath);
  directory=path.resolve(directory);await mkdir(path.dirname(directory),{recursive:true});
  const staging=await mkdtemp(path.join(path.dirname(directory),'.prepare-client-'));
  await mkdir(path.join(staging,'objects'));
  const manifest={format:1,created:new Date().toISOString(),entries:{}},pending=new Set();
  let browser,electronApp,page,context,failure,bytesDownloaded=0,published=false,lastProgress=0,phaseProgress=0,phaseStage='Connecting to TETR.IO';
  const report=(stage,progress,extra={})=>{phaseProgress=Math.max(phaseProgress,progress);phaseStage=stage;onProgress({stage,progress:phaseProgress,files:Object.keys(manifest.entries).length,bytes:bytesDownloaded,...extra});};
  const check=()=>{if(signal?.aborted)throw Error('Setup cancelled');if(failure)throw failure;};
  const close=async()=>{await browser?.close().catch(()=>{});await electronApp?.close().catch(()=>{});};
  const abort=()=>{void close()};signal?.addEventListener('abort',abort,{once:true});
  async function save(method,address,body,type,status=200){
    if(method!=='GET'||status!==200)return;
    const hash=digest(body);await writeFile(path.join(staging,'objects',hash),body);
    const key=`GET ${address}`;if(!manifest.entries[key])bytesDownloaded+=body.length;
    manifest.entries[key]={hash,status,type};
    if(Date.now()-lastProgress>200){lastProgress=Date.now();report(phaseStage,.2);}
  }
  try{
    check();report('Connecting to TETR.IO',.03);
    if(engine==='electron'){
      const entry=resourcePath('src/experimental/prepare-main.cjs');
      electronApp=await _electron.launch({executablePath:await electronExecutable(),args:[entry],env:engineEnvironment(entry),timeout:30000});
      check();context=electronApp.context();page=await electronApp.firstWindow();
      await page.setViewportSize({width:1280,height:720});
    }else{
      browser=await chromium.launch({...(chrome?{executablePath:chrome}:{channel:'chrome'}),headless:true,args:['--autoplay-policy=no-user-gesture-required',...(software?['--enable-unsafe-swiftshader','--use-angle=swiftshader']:process.platform==='darwin'?['--use-angle=metal']:[])]});
      context=await browser.newContext({viewport:{width:1280,height:720}});page=await context.newPage();
    }
    check();page.setDefaultTimeout(120000);
    await context.routeWebSocket('**/*',ws=>ws.close());
    await page.addInitScript(()=>{window.__offlineMode=true;});
    await page.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(!allowed(request.url()))return route.abort();
      if(url.pathname==='/js/tetrio.js'){
        try{
          const response=await route.fetch({timeout:30000}),body=await response.body();
          if(response.status()!==200)throw Error(`TETR.IO download returned HTTP ${response.status()}`);
          let patched;
          try{patched=patchClient(body.toString());}catch{throw Error('This TETR.IO version is not supported by this renderer yet. Your existing game files were kept.');}
          await save(request.method(),request.url(),body,'application/javascript');
          await route.fulfill({response,body:patched});
        }catch(error){failure=error;await route.abort().catch(()=>{});}
      }else await route.continue();
    });
    page.on('response',response=>{
      if(response.status()!==200||response.request().method()!=='GET'||!allowed(response.url())||new URL(response.url()).pathname==='/js/tetrio.js')return;
      const task=(async()=>{
        try{await save(response.request().method(),response.url(),await response.body(),response.headers()['content-type']||'application/octet-stream',response.status());}
        catch(error){if(!signal?.aborted)failure??=error;}
      })();pending.add(task);task.finally(()=>pending.delete(task));
    });
    await page.goto('https://tetr.io/',{waitUntil:'domcontentloaded',timeout:60000});
    for(let i=0;i<120;i++){
      check();if(await page.evaluate(()=>typeof window.DEVHOOK_LOAD_REPLAY_RAW==='function'))break;
      if(await page.locator('#entry_button').isVisible())await page.locator('#entry_button').click({force:true});
      await page.waitForTimeout(1000);
    }
    check();await page.waitForFunction(()=>typeof window.DEVHOOK_LOAD_REPLAY_RAW==='function');
    report('Loading textures, fonts and audio',.4);
    await page.waitForFunction(()=>document.getElementById('preload')?.classList.contains('ready')&&document.getElementById('preload')?.classList.contains('hidden'));
    check();report('Preparing files for your replay',.55);
    const startSelector=await importReplay(page,replayInput);
    await page.locator(startSelector).first().evaluate(element=>element.click());
    await page.waitForFunction(()=>!document.getElementById('replaytools').classList.contains('disabled'));
    await page.evaluate(singleplayer=>{
      if(!singleplayer)document.getElementById('replaytools_button_nextround').click();
      document.getElementById('replaytools_button_10x').click();
    },replayInput.singleplayer);
    for(let i=0;i<25;i++){check();await page.waitForTimeout(1000);}
    report('Downloading backgrounds and music',.7);
    const urls=[...Array.from({length:35},(_,i)=>`https://tetr.io/res/bg/${i+1}.jpg`),'https://tetr.io/res/bgm/shikiichi-made-mousukoshi.mp3'];
    for(let i=0;i<urls.length;i+=4){
      check();await Promise.all(urls.slice(i,i+4).map(async url=>{
        let error;
        for(let attempt=0;attempt<3;attempt++)try{
          check();const response=await context.request.get(url,{timeout:30000});if(!response.ok())throw Error(`HTTP ${response.status()}`);
          await save('GET',url,await response.body(),response.headers()['content-type']||'application/octet-stream');return;
        }catch(cause){error=cause;}
        throw Error(`Could not download ${new URL(url).pathname}: ${error.message}`);
      }));
      report('Downloading backgrounds and music',.7+.15*Math.min(1,(i+4)/urls.length));
    }
    await Promise.all([...pending]);check();
    manifest.game=Object.keys(manifest.entries).find(key=>new URL(key.slice(4)).pathname==='/js/tetrio.js');
    manifest.hardVersion=await page.evaluate(()=>window.HARD_VER);
    await writeFile(path.join(staging,'manifest.json'),JSON.stringify(manifest,null,2));
    report('Checking downloaded files',.9);await validatePreparedClient(staging);check();
    await close();browser=null;electronApp=null;check();
    await publishPreparedClient(staging,directory);published=true;
    report('Game files downloaded',.95);return {directory,manifest};
  }catch(error){
    if(signal?.aborted)throw Error('Setup cancelled');
    if(failure)throw failure;
    throw error;
  }finally{
    signal?.removeEventListener('abort',abort);await close();await Promise.allSettled([...pending]);
    if(!published)await rm(staging,{recursive:true,force:true});
  }
}
