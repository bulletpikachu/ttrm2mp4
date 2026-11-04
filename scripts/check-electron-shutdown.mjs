// Hidden export windows must exit normally even if the game vetoes page unload.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {_electron} from 'playwright-core';
import electron from 'electron';
import {closeElectron} from '../src/offline/electron-shutdown.mjs';

assert.equal(process.platform,'win32','This regression check targets Windows shutdown');
for(const veto of [false,true]){
  const app=await _electron.launch({executablePath:electron,args:[fileURLToPath(new URL('../src/experimental/electron-main.cjs',import.meta.url))]});
  const child=app.process();let forced=false,cleanup=null;
  const timer=setTimeout(()=>{
    if(child.exitCode!==null||child.signalCode!==null)return;
    forced=true;
    cleanup=new Promise(resolve=>{
      const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
      killer.once('error',resolve);killer.once('close',resolve);
    });
  },10000);
  try{
    const page=await app.firstWindow();
    if(veto){
      await page.evaluate(()=>{window.onbeforeunload=()=>false});
      await app.evaluate(async({BrowserWindow})=>{
        const extra=new BrowserWindow({show:false});await extra.loadURL('about:blank');
        await extra.webContents.executeJavaScript('window.onbeforeunload=()=>false;void 0');
      });
      assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length),2);
    }
    const started=performance.now();await closeElectron(app);
    assert.equal(forced,false,'Shutdown must not need process termination');
    assert.equal(child.exitCode,0,'Electron must exit normally');
    assert.equal(child.signalCode,null);
    console.log(`PASS: ${veto?'two windows vetoing unload':'ordinary window'} exited normally in ${((performance.now()-started)/1000).toFixed(3)}s.`);
  }finally{clearTimeout(timer);await cleanup;await app.close().catch(()=>{});}
}

// Reproduce a descendant inheriting the parent's output pipes while quit is
// vetoed. Killing only the parent cannot finish Playwright's close promise.
const app=await _electron.launch({executablePath:electron,args:[fileURLToPath(new URL('../src/experimental/electron-main.cjs',import.meta.url))]});
try{
  await app.firstWindow();
  const descendant=await app.evaluate(({app})=>{
    app.on('before-quit',event=>event.preventDefault());
    return process.getBuiltinModule('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:'inherit',windowsHide:true}).pid;
  });
  const marks=[];await closeElectron(app,{forceAfterMs:500,mark:name=>marks.push(name)});
  assert(marks.includes('electronForceKill'),'The forced-tree fallback was exercised');
  assert(marks.includes('electronPipesClosed'),'All inherited export pipes closed');
  assert.throws(()=>process.kill(descendant,0),error=>error.code==='ESRCH','Owned descendant must not remain alive');
  console.log('PASS: timed-out shutdown terminates the owned descendant and closes inherited pipes.');
}finally{await closeElectron(app,{forceAfterMs:500}).catch(()=>{});}
