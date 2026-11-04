import {spawn,execFileSync} from 'node:child_process';

// Call after native media and file handles are flushed. Awaiting close also
// waits for inherited pipes, so a Windows fallback must stop the entire tree.
export async function closeElectron(app,{mark=()=>{},forceAfterMs=3000}={}){
  const child=app.process();let ownGroup=false,forceTask;
  mark('electronCloseRequested');
  child.once('exit',()=>mark('electronExited'));
  child.once('close',()=>mark('electronPipesClosed'));
  if(process.platform!=='win32')try{ownGroup=Number(execFileSync('/bin/ps',['-o','pgid=','-p',String(child.pid)],{encoding:'utf8'}).trim())===child.pid}catch{}
  const force=setTimeout(()=>{
    mark('electronForceKill');
    try{
      if(process.platform==='win32'){
        // This ChildProcess identifies the export we launched. Do not target a
        // stale PID after it has exited, or enumerate unrelated Electron apps.
        if(child.exitCode===null&&child.signalCode===null)forceTask=new Promise(resolve=>{
          const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
          killer.once('error',resolve);killer.once('close',resolve);
        });
      }else if(ownGroup)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');
    }catch{}
  },forceAfterMs);force.unref();
  try{await app.close()}finally{clearTimeout(force);await forceTask}
}
