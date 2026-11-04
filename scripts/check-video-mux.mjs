import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import {createVideoMux} from '../src/offline/video-mux.mjs';
const temp=await mkdtemp(path.join(tmpdir(),'replay-video-mux-check-'));let mux;
function encode(args){const p=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y',...args],{windowsHide:true,maxBuffer:4*1024*1024});assert.equal(p.status,0,p.stderr.toString());return p.stdout;}
try{
  const audio=path.join(temp,'master.m4a');encode(['-f','lavfi','-i','sine=frequency=437:sample_rate=48000:duration=3','-ac','2','-c:a','aac','-threads','1','-b:a','192k',audio]);
  const bounds=[0,43,101,180],videos=[],target=path.join(temp,'master.mp4');mux=await createVideoMux(ffmpeg,target,60,audio,180);
  for(let i=0;i<3;i++){
    const file=path.join(temp,`part-${i}.h264`);encode(['-f','lavfi','-i','testsrc2=size=160x90:rate=60','-frames:v',String(bounds[i+1]-bounds[i]),'-c:v','libx264','-preset','ultrafast','-threads','1','-crf','18','-bf','0','-f','h264',file]);videos.push(await readFile(file));mux.append(file,{startFrame:bounds[i],endFrame:bounds[i+1],fps:60});
  }
  const result=await mux.finish(180);assert.equal(result.frames,180);await mux.close();mux=null;
  const original=path.join(temp,'video.h264');await writeFile(original,Buffer.concat(videos));
  const packets=(file,kind,format)=>encode(['-i',file,'-map',`0:${kind}:0`,'-c','copy','-f',format,'pipe:1']);
  assert(packets(target,'a','adts').equals(packets(audio,'a','adts')),'Every AAC packet is copied unchanged');assert(packets(target,'v','h264').equals(await readFile(original)),'Every H264 packet is copied unchanged');
  const frames=file=>encode(['-r','60','-i',file,'-an','-f','framemd5','pipe:1']).toString().split('\n').filter(s=>s&&!s.startsWith('#')).map(s=>s.split(',').at(-1).trim());
  const actual=frames(target);assert.equal(actual.length,180);assert.deepEqual(actual,frames(original));
  const paddedAudio=path.join(temp,'padded.m4a'),trimmed=path.join(temp,'trimmed.mp4');
  encode(['-f','lavfi','-i','sine=frequency=437:sample_rate=48000:duration=5','-ac','2','-c:a','aac','-threads','1','-b:a','192k',paddedAudio]);
  const audioPacketLimit=Math.ceil(144000/1024)+1; // Include native AAC's priming packet.
  mux=await createVideoMux(ffmpeg,trimmed,60,paddedAudio,180,{audioPacketLimit});
  mux.append([path.join(temp,'part-0.h264'),path.join(temp,'part-1.h264')],{startFrame:0,endFrame:101,fps:60});
  mux.append(path.join(temp,'part-2.h264'),{startFrame:101,endFrame:180,fps:60});
  const trimmedResult=await mux.finish(180);await mux.close();mux=null;assert.equal(trimmedResult.audioPacketLimit,audioPacketLimit);
  assert.deepEqual(frames(trimmed),actual,'Duration trimming must retain every video frame');
  const fullAAC=packets(paddedAudio,'a','adts'),trimmedAAC=packets(trimmed,'a','adts');assert(trimmedAAC.length<fullAAC.length);assert(fullAAC.subarray(0,trimmedAAC.length).equals(trimmedAAC),'Retained AAC packets are an unchanged prefix');
  const pcm=encode(['-i',trimmed,'-map','0:a:0','-c:a','pcm_f32le','-f','f32le','pipe:1']);assert.equal(pcm.length,Math.ceil(144000/1024)*1024*8,'Decoded audio covers only the video timeline plus final AAC padding');
  mux=await createVideoMux(ffmpeg,path.join(temp,'cancelled.mp4'),60,audio,180);
  assert.throws(()=>mux.append([],{startFrame:0,endFrame:43,fps:60}),/no input fragments/);
  assert.throws(()=>mux.append([null],{startFrame:0,endFrame:43,fps:60}),/no input fragments/);
  await mux.close();mux=null;
  mux=await createVideoMux(ffmpeg,path.join(temp,'missing.mp4'),60,audio,180);mux.append(path.join(temp,'absent.h264'),{startFrame:0,endFrame:180,fps:60});await assert.rejects(mux.finish(180));await mux.close();mux=null;
  console.log('PASS: all 180 decoded frames and AAC/H264 packet prefixes are preserved, packet limits bound AAC padding, and cancellation/missing input fail cleanly.');
}finally{await mux?.close();assert.equal(path.dirname(path.resolve(temp)),path.resolve(tmpdir()));assert(path.basename(temp).startsWith('replay-video-mux-check-'));await rm(temp,{recursive:true,force:true});}
