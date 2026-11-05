import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {_electron} from 'playwright-core';
import electron from 'electron';
const root=fileURLToPath(new URL('../',import.meta.url)),temp=await mkdtemp(path.join(tmpdir(),'replay-setup-ui-'));
const data=path.join(temp,'app-data');await mkdir(data);
await writeFile(path.join(data,'preferences.json'),JSON.stringify({clientDirectory:path.join(temp,'missing-client'),outputDirectory:temp}));
let app;
try{
  app=await _electron.launch({executablePath:process.argv[2]||electron,args:process.argv[2]?[]:[root],cwd:temp,env:{...process.env,REPLAY_DESKTOP_USER_DATA:data}});
  const page=await app.firstWindow();page.setDefaultTimeout(120000);
  const pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
  await page.getByText('Set up TETR.IO files once',{exact:true}).waitFor();
  await page.evaluate(()=>{window.setupEvents=[];window.replayRender.onEvent(event=>{window.setupEvents.push(event);if(event.type.startsWith('setup-'))console.log('SETUP',JSON.stringify(event));});});
  page.on('console',message=>console.log(message.text()));
  await page.locator('input[type=file]').setInputFiles(path.join(root,'replay.ttrm'));
  await page.getByRole('button',{name:'Queue 1',exact:true}).waitFor();
  await page.getByRole('button',{name:'Set up & render',exact:true}).click();
  await Promise.race([
    page.getByText('All exports complete',{exact:true}).waitFor({timeout:300000}),
    page.getByRole('alert').waitFor({timeout:300000}).then(async()=>{throw Error(await page.getByRole('alert').innerText());}),
  ]);
  const events=await page.evaluate(()=>window.setupEvents);
  assert(events.some(event=>event.type==='setup-progress'&&event.files>0),'Real files downloaded');
  assert(events.some(event=>event.type==='setup-completed'),'Setup activated only after offline verification');
  const result=events.find(event=>event.type==='finished');assert(result?.output);assert((await stat(result.output)).size>0);
  const prefs=JSON.parse(await readFile(path.join(data,'preferences.json'),'utf8'));
  assert(prefs.clientDirectory.startsWith(path.join(data,'clients')));
  const manifest=JSON.parse(await readFile(path.join(prefs.clientDirectory,'manifest.json'),'utf8'));assert(manifest.game);
  await page.screenshot({path:'/tmp/replay-render-setup-complete.png',fullPage:true});
  // Cancel a refresh without invalidating the previously activated cache.
  await page.evaluate(()=>{window.setupEvents=[];});
  await page.getByRole('button',{name:'Download fresh game files',exact:true}).click();
  await page.waitForFunction(()=>window.setupEvents.some(event=>event.type==='setup-progress'&&event.bytes>0));
  await page.getByRole('button',{name:'Cancel setup',exact:true}).click();
  await page.getByText('Setup cancelled',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Download fresh game files',exact:true}).waitFor({state:'visible'});
  await page.waitForFunction(()=>!document.querySelector('.setup-refresh').disabled);
  const preserved=JSON.parse(await readFile(path.join(data,'preferences.json'),'utf8'));assert.equal(preserved.clientDirectory,prefs.clientDirectory);
  await stat(path.join(prefs.clientDirectory,'manifest.json'));
  assert.equal(pageErrors.length,0,pageErrors.join('\n'));
  console.log(JSON.stringify({passed:true,temp,output:result.output,client:prefs.clientDirectory,files:Object.keys(manifest.entries).length,version:manifest.hardVersion}));
}finally{if(app){const timer=setTimeout(()=>app.process().kill('SIGKILL'),6000);try{await app.close()}finally{clearTimeout(timer)}}}
