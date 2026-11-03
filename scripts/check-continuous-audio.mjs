// Integration check: arbitrary PCM round boundaries must not alter AAC packets.
import {createContinuousAudio} from '../src/offline/continuous-audio.mjs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
const directory=await mkdtemp(path.join(tmpdir(),'replay-aac-check-'));
let stream;
function encode(args){const result=spawnSync(ffmpeg,['-hide_banner','-loglevel','error',...args]);if(result.status!==0)throw Error(result.stderr.toString());return result.stdout;}
try{
  const pcm=new Float32Array(48000*3*2);
  for(let i=0;i<pcm.length/2;i++){pcm[i*2]=.4*Math.sin(i*2*Math.PI*437/48000);pcm[i*2+1]=.3*Math.sin(i*2*Math.PI*601/48000);}
  const bytes=Buffer.from(pcm.buffer),master=path.join(directory,'master.f32');await writeFile(master,bytes);
  const bounds=[0,43,101,180],target=path.join(directory,'stream.m4a');
  stream=createContinuousAudio(ffmpeg,target,48000);
  for(let i=0;i<bounds.length-1;i++){
    const first=bounds[i],last=bounds[i+1],file=path.join(directory,'part-'+i+'.f32');
    await writeFile(file,bytes.subarray(first*800*8,last*800*8));stream.append(file,{startFrame:first,endFrame:last,fps:60,sampleRate:48000});
  }
  await stream.finish(createHash('sha256').update(bytes).digest('hex'),bytes.length);await stream.close();stream=null;
  const reference=path.join(directory,'reference.m4a');encode(['-f','f32le','-ar','48000','-ac','2','-i',master,'-c:a','aac','-b:a','192k',reference]);
  const packets=file=>encode(['-i',file,'-map','0:a:0','-c:a','copy','-f','adts','pipe:1']);
  if(!packets(target).equals(packets(reference)))throw Error('Streamed AAC differs from whole-file AAC');
  stream=createContinuousAudio(ffmpeg,path.join(directory,'cancelled.m4a'),48000);stream.append(master,{startFrame:0,endFrame:180,fps:60,sampleRate:48000});await stream.close();stream=null;
  console.log('PASS: round-boundary streaming produces identical AAC packets; cancellation completes.');
}finally{await stream?.close();await rm(directory,{recursive:true,force:true});}
