import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {setPriority} from 'node:os';

// Independent input chains prevent FFmpeg's two demuxers from deadlocking
// when one round is larger than either pipe's buffer. No video is re-encoded.
export function createContinuousMux(ffmpeg,output,fps,sampleRate,maxFrames=0){
  const index=process.env.REPLAY_RESERVE_MOOV==='1'?['-moov_size',String(Math.max(1048576,Math.ceil(maxFrames*64+1048576)))]:['-movflags','+faststart'];
  const child=spawn(ffmpeg,['-hide_banner','-loglevel','warning','-nostdin','-y',
    '-filter_threads','1','-probesize','32768','-analyzeduration','0',
    '-r',String(fps),'-f','h264','-i','pipe:0',
    '-f','f32le','-ar',String(sampleRate),'-ac','2','-i','pipe:3',
    '-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-threads','1','-b:a','192k',...index,output],{stdio:['pipe','ignore','pipe','pipe']});
  const priority=process.env.REPLAY_MUX_FOREGROUND==='1'?0:10;
  if(child.pid)try{setPriority(child.pid,priority)}catch{}
  const video=child.stdin,audio=child.stdio[3],hash=createHash('sha256');
  let failure=null,errors='',cursor=0,bytes=0,finished=false,videoPending=Promise.resolve(),audioPending=Promise.resolve();
  const fail=error=>{if(failure)return;failure=error;video.destroy();audio.destroy();child.kill('SIGTERM')};
  video.on('error',fail);audio.on('error',fail);child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-4000)});
  const completion=new Promise(resolve=>{child.once('error',error=>{fail(error);resolve()});child.once('close',code=>{if(code!==0)failure??=Error('Continuous MP4 packaging failed: '+errors);resolve()})});
  function check(){if(failure)throw failure}
  function drain(stream){return new Promise((resolve,reject)=>{
    const clear=()=>{stream.off('drain',ready);stream.off('error',failed);stream.off('close',closed)};
    const ready=()=>{clear();resolve()},failed=error=>{clear();reject(error)},closed=()=>failed(Error('Continuous mux input closed before draining'));
    stream.once('drain',ready);stream.once('error',failed);stream.once('close',closed);
  })}
  async function copy(file,stream,pcm=false){let count=0;for await(const chunk of createReadStream(file)){check();count+=chunk.length;if(pcm){bytes+=chunk.length;hash.update(chunk)}if(!stream.write(chunk))await drain(stream)}return count;}
  return{
    append(videoFile,audioFile,{startFrame,endFrame,fps:rate,sampleRate:audioRate}){
      if(finished)throw Error('Continuous MP4 stream is already finished');
      if(startFrame!==cursor||endFrame<=startFrame||rate!==fps||audioRate!==sampleRate)throw Error('Continuous MP4 ranges are not contiguous');
      const expected=(Math.round(endFrame/fps*sampleRate)-Math.round(startFrame/fps*sampleRate))*8;cursor=endFrame;
      videoPending=videoPending.then(()=>copy(videoFile,video)).catch(fail);
      audioPending=audioPending.then(async()=>{if(await copy(audioFile,audio,true)!==expected)throw Error('Continuous mux audio range has an unexpected sample count')}).catch(fail);
    },
    async finish(expectedHash,expectedBytes,expectedFrames){
      finished=true;await Promise.all([videoPending.then(()=>video.end()),audioPending.then(()=>audio.end())]);check();
      const pcmSha256=hash.digest('hex');
      if(pcmSha256!==expectedHash||bytes!==expectedBytes||cursor!==expectedFrames){fail(Error('Streamed master inputs differ from the independently rendered timeline/PCM'));throw failure;}
      await completion;check();return{pcmSha256,bytes,frames:cursor,verified:true,videoCopied:true,reservedIndexBytes:index[0]==='-moov_size'?Number(index[1]):0,priority};
    },
    async close(){if(!finished)fail(Error('Continuous MP4 cancelled'));video.destroy();audio.destroy();if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await completion;await Promise.all([videoPending,audioPending]);},
  };
}
