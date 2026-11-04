// Real offline Electron transport: unchanged pinned bytes/patches, missing
// requests and methods fail without falling through to the network.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import {createLocalClientStore,attachLocalClient} from '../src/offline/client.mjs';
import {closeElectron} from '../src/offline/electron-shutdown.mjs';
import {_electron} from 'playwright-core';
import electron from 'electron';
assert.equal(process.platform,'win32');
const directory=fileURLToPath(new URL('../client',import.meta.url));
const store=await createLocalClientStore(directory);
const entries=Object.entries(store.manifest.entries);
const image=entries.find(([key,value])=>key.startsWith('GET https://tetr.io/')&&value.type.startsWith('image/'))?.[0].slice(4);
assert(image,'Prepared client includes an image');
const addresses=['https://tetr.io/','https://tetr.io/js/tetrio.js',image];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
for(const native of [false,true]){
  const app=await _electron.launch({executablePath:electron,args:[fileURLToPath(new URL('../src/experimental/electron-main.cjs',import.meta.url))],env:{...process.env,REPLAY_WINDOWS_NATIVE_CLIENT:'1'}});
  try{
    const cache=await attachLocalClient(app.context(),directory,{},native?app:null);
    const page=await app.firstWindow();
    for(const address of addresses){
      const expected=await store.response('GET',address);assert(expected);
      const actual=await page.evaluate(async address=>{const response=await fetch(address);return{status:response.status,type:response.headers.get('content-type'),bytes:Array.from(new Uint8Array(await response.arrayBuffer()))};},address);
      assert.equal(actual.status,expected.status);assert.equal(actual.type,expected.headers['content-type']);assert.equal(hash(Buffer.from(actual.bytes)),hash(expected.body),'Identical response bytes, including pinned client patches');
    }
    for(const [method,address]of [['GET','https://example.invalid/blocked'],['GET','http://example.invalid/blocked'],['POST',image]]){
      assert(await page.evaluate(async({method,address})=>{try{await fetch(address,{method});return false;}catch{return true;}},{method,address}),'Uncached request must fail while offline');
    }
    await cache.refresh?.();assert(cache.missing.has('GET https://example.invalid/blocked'));assert(cache.missing.has('GET http://example.invalid/blocked'));
    const original=await readFile(new URL('../client/manifest.json',import.meta.url),'utf8');assert.deepEqual(cache.manifest,JSON.parse(original));
    console.log(`PASS: ${cache.transport}: original HTML/image bytes, identical patched client, missing HTTP/HTTPS/method requests rejected with Chromium offline.`);
  }finally{await closeElectron(app);}
}
