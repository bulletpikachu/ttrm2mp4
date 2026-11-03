import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {setPriority} from 'node:os';

// Feed exact, contiguous round PCM to one AAC encoder while later rounds draw.
// The final master PCM remains independently rendered and verifies this stream.
export function createContinuousAudio(ffmpeg,output,sampleRate){
  const child=spawn(ffmpeg,['-hide_banner','-loglevel','warning','-nostdin','-y',
    '-filter_threads','1',
    '-f','f32le','-ar',String(sampleRate),'-ac','2','-i','pipe:0','-vn',
    '-c:a','aac','-threads','1','-b:a','192k','-movflags','+faststart',output],{stdio:['pipe','ignore','pipe']});
  // Lower CPU priority while the foreground native simulation is rendering.
  if(child.pid)try{setPriority(child.pid,10)}catch{}
  const hash=createHash('sha256');let errors='',failure=null,cursor=0,bytes=0,finished=false;
  child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-4000)});
  child.stdin.on('error',error=>{failure??=error});
  const completion=new Promise(resolve=>{
    child.once('error',error=>{failure??=error;resolve()});
    child.once('close',code=>{if(code!==0)failure??=Error('Continuous AAC encoder failed: '+errors);resolve()});
  });
  let pending=Promise.resolve();
  function check(){if(failure)throw failure}
  function drained(){return new Promise((resolve,reject)=>{
    const clear=()=>{child.stdin.off('drain',ready);child.stdin.off('error',failed);child.stdin.off('close',closed)};
    const ready=()=>{clear();resolve()},failed=error=>{clear();reject(error)},closed=()=>failed(Error('Continuous AAC input closed before draining'));
    child.stdin.once('drain',ready);child.stdin.once('error',failed);child.stdin.once('close',closed);
  })}
  return {
    append(file,{startFrame,endFrame,fps,sampleRate:rate}){
      if(finished)throw Error('Continuous audio stream is already finished');
      if(startFrame!==cursor||rate!==sampleRate)throw Error('Continuous audio ranges are not contiguous');
      const expected=(Math.round(endFrame/fps*sampleRate)-Math.round(startFrame/fps*sampleRate))*8;
      cursor=endFrame;
      pending=pending.then(async()=>{
        check();let count=0;
        for await(const chunk of createReadStream(file)){
          check();count+=chunk.length;hash.update(chunk);bytes+=chunk.length;
          if(!child.stdin.write(chunk))await drained();
        }
        if(count!==expected)throw Error('Continuous audio range has an unexpected sample count');
      }).catch(error=>{failure??=error;child.stdin.destroy();child.kill('SIGTERM')});
    },
    async finish(expectedHash,expectedBytes){
      finished=true;await pending;check();child.stdin.end();await completion;check();
      const pcmSha256=hash.digest('hex');
      if(pcmSha256!==expectedHash||bytes!==expectedBytes)throw Error('Streamed continuous audio differs from independently rendered master PCM');
      return{pcmSha256,bytes,frames:cursor,verified:true};
    },
    async close(){if(!finished)failure??=Error('Continuous audio cancelled');child.stdin.destroy();if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await completion;await pending;},
  };
}
