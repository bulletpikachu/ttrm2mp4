#!/usr/bin/env node
import { chromium } from 'playwright-core';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { patchClient } from './offline/client.mjs';
const bundle = path.resolve('client');
await mkdir(path.join(bundle, 'objects'), { recursive: true });
const manifest = { format: 1, created: new Date().toISOString(), entries: {} };
let pending = new Set();
let page;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : [])] });
try {
  const cdp = await browser.newBrowserCDPSession();
  const { userAgent } = await cdp.send('Browser.getVersion');
  page = await browser.newPage({ viewport: { width: 1280, height: 720 }, userAgent: userAgent.replace('HeadlessChrome/', 'Chrome/') });
  page.setDefaultTimeout(120000);
  page.on('pageerror', error => console.log('Client error:',error.message));
  page.on('console', msg=>{if(['log','error'].includes(msg.type())) console.log('Client:',msg.text().slice(0,200))});
  await page.addInitScript(() => { window.__offlineMode = true; });
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (!/(^|\.)tetr\.io$/.test(url.hostname)) return route.abort();
    if (url.pathname === '/js/tetrio.js') {
      const response = await route.fetch();
      const bytes = await response.body();
      const hash = createHash('sha256').update(bytes).digest('hex');
      await writeFile(path.join(bundle,'objects',hash),bytes);
      manifest.entries[`${req.method()} ${req.url()}`] = {hash,status:response.status(),type:'application/javascript'};
      return route.fulfill({response,body:patchClient(bytes.toString())});
    }
    return route.continue();
  });
  page.on('response', response => {
    if (!/(^|\.)tetr\.io$/.test(new URL(response.url()).hostname) || new URL(response.url()).pathname === '/js/tetrio.js') return;
    const task = (async () => {
      try {
        if (response.status() >= 300) {console.log('HTTP',response.status(),response.url());return;}
        const body = await response.body();
        const hash = createHash('sha256').update(body).digest('hex');
        await writeFile(path.join(bundle, 'objects', hash), body);
        manifest.entries[`${response.request().method()} ${response.url()}`] = { hash, status: response.status(), type: response.headers()['content-type'] || 'application/octet-stream' };
      } catch (e) { console.log('Capture skipped:', response.url(), e.message.slice(0,100)); }
    })();
    pending.add(task); task.finally(() => pending.delete(task));
  });
  console.log('Capturing pinned native client and assets…');
  await page.goto('https://tetr.io/', { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 120; i++) {
    if (await page.evaluate(() => typeof window.DEVHOOK_LOAD_REPLAY_RAW === 'function')) break;
    if (await page.locator('#entry_button').isVisible()) await page.locator('#entry_button').click({force:true});
    await page.waitForTimeout(1000);
    if (i % 5 === 0) { console.log('Startup', await page.evaluate(()=>({entry:document.getElementById('entry_form')?.className,preload:document.getElementById('preload')?.innerText}))); await page.screenshot({path:'.inspect/prepare-progress.png'}); await Promise.allSettled([...pending]); await writeFile(path.join(bundle,'manifest.json'),JSON.stringify(manifest,null,2)); }
  }
  await page.waitForFunction(() => typeof window.DEVHOOK_LOAD_REPLAY_RAW === 'function');
  console.log('Game hooks ready. Waiting for textures/fonts/audio…');
  try { await page.waitForFunction(() => document.getElementById('preload')?.classList.contains('ready') && document.getElementById('preload')?.classList.contains('hidden')); } catch(e) { await page.screenshot({path:'.inspect/prepare-error.png'});console.log(await page.locator('#preload').evaluate(el=>({classes:el.className,text:el.innerText})));throw e; }
  console.log('Base assets loaded. Warming replay assets…');
  const replay = JSON.parse(await readFile(process.argv[2] || 'd49cd02df245.ttrm', 'utf8'));
  replay.id = null;
  const raw = JSON.stringify(replay);
  await page.evaluate(raw => {
    const dt = new DataTransfer();dt.items.add(new File([raw], 'warmup.ttrm', { type: 'application/json' }));
    document.getElementById('menus').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
  }, raw);
  await page.locator('#multilog .multilog_result').first().evaluate(el=>el.click());
  await page.waitForFunction(() => !document.getElementById('replaytools').classList.contains('disabled'));
  await page.evaluate(() => { document.getElementById('replaytools_button_nextround').click();document.getElementById('replaytools_button_10x').click(); });
  await page.waitForTimeout(25000);
  console.log('Caching the native background library…');
  const urls = [...Array.from({length:35},(_,i)=>`https://tetr.io/res/bg/${i+1}.jpg`), "https://tetr.io/res/bgm/shikiichi-made-mousukoshi.mp3"];
  for(let i=0;i<urls.length;i+=4) await Promise.all(urls.slice(i,i+4).map(async url=>{
    for(let attempt=0;attempt<3;attempt++){
      try{
        const response=await page.request.get(url,{timeout:30000});
        if(!response.ok())throw Error(`HTTP ${response.status()}`);
        const bytes=await response.body(),hash=createHash('sha256').update(bytes).digest('hex');
        await writeFile(path.join(bundle,'objects',hash),bytes);
        manifest.entries[`GET ${url}`]={hash,status:response.status(),type:response.headers()['content-type']||'image/jpeg'};
        return;
      }catch(e){if(attempt===2)throw Error(`Cannot cache ${url}: ${e.message}`)}
    }
  }));
  await Promise.allSettled([...pending]);
  const game = Object.entries(manifest.entries).find(([k]) => /\/js\/tetrio\.js[? ]?/.test(k));
  if (!game) throw Error('Game JavaScript was not captured.');
  manifest.game = game[0];
  manifest.hardVersion = await page.evaluate(() => window.HARD_VER);
  await writeFile(path.join(bundle, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`Saved ${Object.keys(manifest.entries).length} responses to ${bundle}`);
} finally { await page?.screenshot({path:'.inspect/prepare-last.png'}).catch(()=>{}); await Promise.allSettled([...pending]); await writeFile(path.join(bundle, 'manifest.json'), JSON.stringify(manifest,null,2)); await browser.close(); }
