#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile, mkdir, access, rename, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import ffmpeg from 'ffmpeg-static';
const worker = fileURLToPath(new URL('./render.mjs', import.meta.url));
async function main() {
  const start = performance.now();
  const {values:o,positionals:p}=parseArgs({allowPositionals:true,options:{
    encoder:{type:'string',default:'hardware'},queue:{type:'string',default:'8'},jobs:{type:'string',default:'2'},width:{type:'string',default:'1920'},height:{type:'string',default:'1080'},fps:{type:'string',default:'60'},
    client:{type:'string',default:'client'},chrome:{type:'string'},report:{type:'boolean'},overwrite:{type:'boolean'},help:{type:'boolean'},
  }});
  if(o.help) return console.log('Usage: npm run render-parallel -- input.ttrm output.mp4 [--jobs 2] [--width 1920 --height 1080 --fps 60] [--report] [--overwrite]\nEach round is saved immediately in output-rounds/. The completed rounds are also joined without re-encoding.');
  if(p.length!==2)throw Error('Provide input.ttrm and output.mp4.');
  if(!['hardware','software'].includes(o.encoder))throw Error('Unsupported encoder');
  if(!Number.isInteger(Number(o.queue))||Number(o.queue)<1||Number(o.queue)>240)throw Error('Unsupported queue');
  const jobs=Number(o.jobs);
  if(!Number.isInteger(jobs)||jobs<1||jobs>16)throw Error('--jobs must be between 1 and 16.');
  for(const k of ['width','height','fps'])if(!Number.isInteger(Number(o[k]))||Number(o[k])<1)throw Error(`Invalid ${k}`);
  if(Number(o.width)%2||Number(o.height)%2||Number(o.width)>3840||Number(o.height)>2160||Number(o.fps)>60)throw Error('Unsupported video settings.');
  const input=path.resolve(p[0]),output=path.resolve(p[1]);
  if(!/\.ttrm$/i.test(input)||!/\.mp4$/i.test(output))throw Error('Expected .ttrm input and .mp4 output.');
  const replay=JSON.parse(await readFile(input,'utf8')),rounds=replay.replay?.rounds;
  if(!Array.isArray(rounds)||!rounds.length||rounds.some(r=>!Array.isArray(r)||r.length!==2||r.some(p=>!Number.isFinite(p.replay?.frames)||p.replay.frames<=0||!Array.isArray(p.replay.events))))throw Error('Expected complete two-player multiplayer replay data.');
  const directory=output.replace(/\.mp4$/i,'-rounds'),reportFile=o.report?output.replace(/\.mp4$/i,'.json'):null;
  if(!o.overwrite)for(const target of reportFile?[output,directory,reportFile]:[output,directory]){
    try{await access(target);throw Error(`Output exists: ${target}. Use --overwrite.`)}catch(e){if(e.code!=='ENOENT')throw e}
  }
  await mkdir(directory,{recursive:true});
  const paths=rounds.map((_,i)=>path.join(directory,`round-${String(i+1).padStart(2,'0')}.mp4`));
  const reports=new Array(rounds.length),children=new Set();let failed=false;
  const stop=()=>{failed=true;for(const child of children)child.kill('SIGTERM')};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  // Start longer rounds first to reduce idle time at the end of the pool.
  const queue=rounds.map((r,i)=>({i,frames:Math.max(...r.map(p=>p.replay.frames))})).sort((a,b)=>b.frames-a.frames);
  console.log(`Rendering ${rounds.length} rounds with ${Math.min(jobs,rounds.length)} workers at ${o.width}×${o.height}/${o.fps} fps.`);
  try{
    await Promise.all(Array.from({length:Math.min(jobs,rounds.length)},async()=>{
      while(queue.length&&!failed){
        const {i}=queue.shift();
        const args=[worker,input,paths[i],'--round',String(i+1),'--width',o.width,'--height',o.height,'--fps',o.fps,'--client',path.resolve(o.client),'--encoder',o.encoder,'--queue',o.queue];
        if(o.chrome)args.push('--chrome',o.chrome);if(o.overwrite)args.push('--overwrite');
        const child=spawn(process.execPath,args,{env:{...process.env,REPLAY_WORKER_RESULT:'1'},stdio:['ignore','pipe','pipe','ipc']});children.add(child);
        child.on('message',message=>{if(message.type==='render-result')reports[i]=message.report;});
        let log='';child.stdout.on('data',d=>{log=(log+d).slice(-10000)});child.stderr.on('data',d=>{log=(log+d).slice(-10000)});
        try{
          const [code]=await once(child,'close');
          if(code!==0)throw Error(`Round ${i+1} failed: ${log}`);
          if(!reports[i])throw Error(`Round ${i+1} did not send a render result`);
        }catch(e){stop();throw e}finally{children.delete(child)}
        console.log(`Round ${i+1} saved: ${paths[i]} (${((performance.now()-start)/1000).toFixed(1)}s elapsed)`);
      }
    }));
    if(failed)throw Error('Parallel render interrupted. Completed round files were preserved.');
    const temp=await mkdtemp(path.join(path.dirname(output),'.replay-render-'));
    try{
      const list=path.join(temp,'rounds.txt');
      await writeFile(list,paths.map(f=>`file '${f.replace(/'/g,"'\\''")}'`).join('\n')+'\n');
      const staged=path.join(temp,'combined.mp4');
      const child=spawn(ffmpeg,['-hide_banner','-loglevel','warning','-nostdin','-y','-f','concat','-safe','0','-i',list,'-c','copy','-movflags','+faststart',staged],{stdio:['ignore','ignore','pipe']});
      let errors='';child.stderr.on('data',d=>{errors=(errors+d).slice(-5000)});
      const [code]=await once(child,'exit');if(code!==0)throw Error('Joining rounds failed: '+errors);
      await rename(staged,output);
    }finally{await rm(temp,{recursive:true,force:true})}
    const elapsedSeconds=(performance.now()-start)/1000,duration=reports.reduce((s,r)=>s+r.duration,0);
    const report={input,output,directory,jobs,encoder:o.encoder,queue:Number(o.queue),width:Number(o.width),height:Number(o.height),fps:Number(o.fps),duration,elapsedSeconds,speedup:duration/elapsedSeconds,networkingDisabled:reports.every(r=>r.networkingDisabled),rounds:reports};
    if(reportFile)await writeFile(reportFile,JSON.stringify(report,null,2)+'\n');
    console.log(`Saved ${output}\n${duration.toFixed(2)}s video in ${elapsedSeconds.toFixed(2)}s (${report.speedup.toFixed(2)}× real time).`);
  }finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop)}
}
main().catch(e=>{console.error(e.stack||e);process.exitCode=1});
