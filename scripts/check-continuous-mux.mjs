import {createContinuousMux} from '../src/offline/continuous-mux.mjs';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
const directory=await mkdtemp(path.join(tmpdir(),'replay-mux-check-'));
let stream;
function encode(args){const result=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-y',...args]);if(result.status!==0)throw Error(result.stderr.toString());return result.stdout;}
try{
  const pcm=new Float32Array(48000*3*2);for(let i=0;i<pcm.length/2;i++){pcm[i*2]=.4*Math.sin(i*2*Math.PI*437/48000);pcm[i*2+1]=.3*Math.sin(i*2*Math.PI*601/48000);}
  const bytes=Buffer.from(pcm.buffer),master=path.join(directory,'master.f32');await writeFile(master,bytes);
  const bounds=[0,43,101,180],target=path.join(directory,'stream.mp4'),videos=[];
  stream=createContinuousMux(ffmpeg,target,60,48000);
  for(let i=0;i<bounds.length-1;i++){
    const first=bounds[i],last=bounds[i+1],audio=path.join(directory,'part-'+i+'.f32'),video=path.join(directory,'part-'+i+'.h264');
    encode(['-f','lavfi','-i','testsrc2=size=160x90:rate=60','-frames:v',String(last-first),'-c:v','libx264','-threads','1','-preset','ultrafast','-crf','18','-bf','0','-f','h264',video]);
    videos.push(await readFile(video));await writeFile(audio,bytes.subarray(first*800*8,last*800*8));
    stream.append(video,audio,{startFrame:first,endFrame:last,fps:60,sampleRate:48000});
  }
  await stream.finish(createHash('sha256').update(bytes).digest('hex'),bytes.length,180);await stream.close();stream=null;
  const raw=path.join(directory,'master.h264'),reference=path.join(directory,'reference.mp4');await writeFile(raw,Buffer.concat(videos));
  encode(['-r','60','-i',raw,'-f','f32le','-ar','48000','-ac','2','-i',master,'-c:v','copy','-c:a','aac','-b:a','192k',reference]);
  const packets=(file,type,format)=>encode(['-i',file,'-map',`0:${type}:0`,'-c','copy','-f',format,'pipe:1']);
  if(!packets(target,'a','adts').equals(packets(reference,'a','adts')))throw Error('Streamed AAC packets differ from whole-file encoding');
  if(!packets(target,'v','h264').equals(packets(reference,'v','h264')))throw Error('Streamed H264 packets differ from original encoding');
  const frames=file=>encode(['-i',file,'-map','0:v:0','-f','framemd5','pipe:1']).toString().split('\n').filter(line=>line&&!line.startsWith('#')).map(line=>line.split(',').at(-1).trim());
  const actual=frames(target),expected=frames(reference);if(actual.length!==180||JSON.stringify(actual)!==JSON.stringify(expected))throw Error('Decoded streamed video differs from original');
  stream=createContinuousMux(ffmpeg,path.join(directory,'cancelled.mp4'),60,48000);await stream.close();stream=null;
  console.log('PASS: progressive mux preserves every H264/AAC packet and all 180 decoded frames; cancellation completes.');
}finally{await stream?.close();await rm(directory,{recursive:true,force:true});}
