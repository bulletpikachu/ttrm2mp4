import {spawn} from 'node:child_process';

// Accept the still-live ChildProcess we launched, never an arbitrary PID or a
// process-name match. Terminate descendants before awaiting scratch cleanup.
export function terminateWindowsProcessTree(child){
  if(process.platform!=='win32')throw Error('Windows process-tree cleanup requires Windows');
  if(!child.pid||child.exitCode!==null||child.signalCode!==null)return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
    let errors='';killer.stderr.on('data',data=>{errors=(errors+data).slice(-2000)});
    killer.once('error',reject);
    killer.once('close',code=>{
      if(code===0||child.exitCode!==null||child.signalCode!==null)resolve();
      else reject(Error('Owned Windows process-tree termination failed: '+errors));
    });
  });
}
