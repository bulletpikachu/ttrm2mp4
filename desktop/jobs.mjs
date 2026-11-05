import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {access,readFile,stat,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {terminateWindowsProcessTree} from '../src/offline/windows-process-tree.mjs';

export async function inspectReplay(file){
  if(typeof file!=='string'||!path.isAbsolute(file)||!/\.ttrm$/i.test(file))throw Error('Choose a .ttrm replay file');
  const info=await stat(file);if(!info.isFile()||info.size>100*1024*1024)throw Error('Replay must be a file smaller than 100 MB');
  const replay=JSON.parse(await readFile(file,'utf8')),rounds=replay.replay?.rounds;
  if(!Array.isArray(rounds)||!rounds.length||rounds.some(round=>!Array.isArray(round)||round.length!==2||round.some(player=>!Number.isFinite(player.replay?.frames)||player.replay.frames<=0||!Array.isArray(player.replay.events))))throw Error('Expected a complete two-player match replay');
  return {id:randomUUID(),path:file,name:path.basename(file),rounds:rounds.length,duration:rounds.reduce((sum,r)=>sum+Math.max(...r.map(p=>p.replay.frames))/60,0)};
}
export function validateSettings(settings){
  const {outputDirectory,clientDirectory,backend='auto',width=1920,height=1080,fps=60}=settings||{};
  if(typeof outputDirectory!=='string'||!path.isAbsolute(outputDirectory))throw Error('Choose an output folder');
  if(typeof clientDirectory!=='string'||!path.isAbsolute(clientDirectory))throw Error('Choose the prepared game-files folder');
  if(!['auto','portable','mac','windows-nvidia'].includes(backend))throw Error('Invalid rendering backend');
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<2||height<2||width>3840||height>2160||width%2||height%2)throw Error('Invalid video dimensions');
  if(!Number.isInteger(fps)||fps<1||fps>60)throw Error('Frame rate must be 1–60');
  return {outputDirectory,clientDirectory,backend,width,height,fps};
}
async function outputPath(directory,input){
  const stem=path.basename(input).replace(/\.ttrm$/i,'');
  for(let i=0;i<1000;i++){
    const target=path.join(directory,`${stem}${i?'-'+(i+1):''}.mp4`);
    const candidates=[target,target.replace(/\.mp4$/,'.json'),target.replace(/\.mp4$/,'-rounds')];
    const present=await Promise.all(candidates.map(file=>access(file).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;})));
    if(present.every(value=>!value))return target;
  }
  throw Error('Too many exports with this filename in the output folder');
}
export class RenderJobs extends EventEmitter{
  constructor({root,executable,userData,spawnWorker=spawn}){super();Object.assign(this,{root,executable,userData,spawnWorker});this.active=null;}
  start(files,rawSettings,appearance){
    if(this.active)throw Error('An export is already running');
    if(!Array.isArray(files)||!files.length||files.length>100)throw Error('Choose 1–100 replay files');
    const settings=validateSettings(rawSettings),job={id:randomUUID(),cancelled:false,child:null};
    this.active=job;
    job.done=this.execute(job,files,settings,appearance).finally(()=>{if(this.active===job)this.active=null;this.emit('event',{jobId:job.id,type:'idle'});});
    return job.id;
  }
  async execute(job,files,settings,appearance){
    const send=event=>this.emit('event',{jobId:job.id,...event});
    try{
      const manifest=JSON.parse(await readFile(path.join(settings.clientDirectory,'manifest.json'),'utf8'));
      if(manifest.format!==1||!manifest.entries)throw Error('Unsupported game-files cache');
      await mkdir(settings.outputDirectory,{recursive:true});
      for(const item of files){
        if(job.cancelled)break;
        const file=await inspectReplay(item.path);
        const output=await outputPath(settings.outputDirectory,file.path);
        if(job.cancelled)break;
        send({type:'started',fileId:item.id,output});
        const args=[file.path,output,'--client',settings.clientDirectory,'--backend',settings.backend,'--width',String(settings.width),'--height',String(settings.height),'--fps',String(settings.fps),...(appearance?['--appearance',appearance]:[])];
        await new Promise((resolve,reject)=>{
          const child=this.spawnWorker(this.executable,[path.join(this.root,'desktop/worker.cjs'),...args],{
            cwd:this.userData,detached:process.platform!=='win32',windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],
            env:{...process.env,ELECTRON_RUN_AS_NODE:'1',REPLAY_RESOURCE_ROOT:this.root,REPLAY_USER_DATA:this.userData,REPLAY_CLIENT_DIRECTORY:settings.clientDirectory,REPLAY_ELECTRON_EXECUTABLE:this.executable,REPLAY_EVENTS:'1',REPLAY_DESKTOP:'1'},
          });job.child=child;send({type:'worker-started',fileId:item.id,pid:child.pid});
          let errors='';
          child.stdout.on('data',data=>send({type:'log',fileId:item.id,message:String(data)}));
          child.stderr.on('data',data=>{errors=(errors+data).slice(-6000);send({type:'log',fileId:item.id,message:String(data)})});
          child.on('message',message=>{if(message?.type==='render-event')send({...message.event,fileId:item.id});});
          child.once('error',reject);
          child.once('close',code=>{job.child=null;job.cancelTask?.then(()=>{});if(job.cancelled||code===0)resolve();else reject(Error(errors.trim().split('\n').find(line=>line.startsWith('Error:'))||errors.trim().slice(-800)||`Renderer exited with code ${code}`));});
        });
        if(job.cancelled){send({type:'cancelled',fileId:item.id});break;}
        await access(output);
        send({type:'finished',fileId:item.id,output});
      }
      send({type:job.cancelled?'cancelled':'done'});
    }catch(error){send({type:job.cancelled?'cancelled':'error',message:error.message});}
    finally{await job.cancelTask;clearTimeout(job.forceTimer);}
  }
  async cancel(){
    const job=this.active;if(!job)return;
    job.cancelled=true;
    const child=job.child;
    if(child&&child.exitCode===null&&child.signalCode===null){
      if(process.platform==='win32'){job.cancelTask=terminateWindowsProcessTree(child);await job.cancelTask;}
      else{
        try{process.kill(-child.pid,'SIGTERM')}catch(error){if(error.code!=='ESRCH')throw error;}
        job.forceTimer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL')}catch{}},6000);job.forceTimer.unref();
      }
    }
    await job.done;
  }
}
