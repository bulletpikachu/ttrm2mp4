import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,rm,access} from 'node:fs/promises';
import path from 'node:path';
import {inspectReplay} from './jobs.mjs';
import {terminateWindowsProcessTree} from '../src/offline/windows-process-tree.mjs';
export async function clientReady(directory){
  try{
    const manifest=JSON.parse(await readFile(path.join(directory,'manifest.json'),'utf8'));
    const game=manifest.entries?.[manifest.game];
    if(manifest.format!==1||!game||!/^[a-f0-9]{64}$/.test(game.hash))return false;
    await access(path.join(directory,'objects',game.hash));return true;
  }catch{return false;}
}
export class ClientSetup extends EventEmitter{
  constructor({root,executable,userData,spawnWorker=spawn}){super();Object.assign(this,{root,executable,userData,spawnWorker});this.active=null;}
  start(replayPath){
    if(this.active)throw Error('Game-file setup is already running');
    const run={id:randomUUID(),cancelled:false,child:null};this.active=run;
    run.done=this.execute(run,replayPath).finally(()=>{if(this.active===run)this.active=null;});
    return run.done;
  }
  async execute(run,replayPath){
    const directory=path.join(this.userData,'clients',run.id,'client'),send=event=>this.emit('event',{setupId:run.id,...event});
    let success=false;
    try{
      await inspectReplay(replayPath);await mkdir(path.dirname(directory),{recursive:true});
      if(run.cancelled)throw Error('Setup cancelled');
      send({type:'setup-progress',stage:'Starting game-file setup',progress:0});
      await new Promise((resolve,reject)=>{
        const child=this.spawnWorker(this.executable,[path.join(this.root,'desktop/setup-worker.cjs'),replayPath,directory],{
          cwd:this.userData,detached:process.platform!=='win32',windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],
          env:{...process.env,ELECTRON_RUN_AS_NODE:'1',REPLAY_RESOURCE_ROOT:this.root,REPLAY_USER_DATA:this.userData,REPLAY_ELECTRON_EXECUTABLE:this.executable},
        });run.child=child;let ready=false,message='Game-file setup failed';
        child.stdout.on('data',data=>send({type:'setup-log',message:String(data)}));
        child.stderr.on('data',data=>send({type:'setup-log',message:String(data)}));
        child.on('message',payload=>{
          if(payload?.type!=='setup-event')return;
          const event=payload.event;
          if(event.type==='setup-ready')ready=event.directory===directory;
          else if(event.type==='setup-error')message=event.message;
          else if(event.type==='setup-progress'||event.type==='setup-log')send(event);
        });
        child.once('error',reject);child.once('close',code=>{run.child=null;run.cancelled?reject(Error('Setup cancelled')):code===0&&ready?resolve():reject(Error(message));});
      });
      if(run.cancelled)throw Error('Setup cancelled');
      if(!await clientReady(directory))throw Error('Downloaded game files are incomplete');
      success=true;send({type:'setup-completed',directory,progress:1,stage:'TETR.IO files are ready'});return directory;
    }catch(error){send({type:run.cancelled?'setup-cancelled':'setup-error',message:error.message});throw error;}
    finally{
      clearTimeout(run.forceTimer);await run.cancelTask?.catch(()=>{});
      if(!success)await rm(path.dirname(directory),{recursive:true,force:true});
    }
  }
  async cancel(){
    const run=this.active;if(!run)return;run.cancelled=true;
    const child=run.child;
    if(child&&child.exitCode===null&&child.signalCode===null){
      if(process.platform==='win32'){run.cancelTask=terminateWindowsProcessTree(child);await run.cancelTask;}
      else{
        try{process.kill(-child.pid,'SIGTERM')}catch(error){if(error.code!=='ESRCH')throw error;}
        run.forceTimer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL')}catch{}},6000);run.forceTimer.unref();
      }
    }
    await run.done.catch(()=>{});
  }
}
