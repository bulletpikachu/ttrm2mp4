import {spawn} from 'node:child_process';
import {writeFile,stat,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {setPriority} from 'node:os';
import path from 'node:path';

// Concatenate completed elementary files without another gigabyte-sized copy.
// The complete AAC source was independently encoded from the native leader.
export async function createVideoMux(ffmpeg,output,fps,audioFile,maxFrames,{audioPacketLimit=null}={}){
  if(audioPacketLimit!==null&&(!Number.isSafeInteger(audioPacketLimit)||audioPacketLimit<=0))throw Error('Invalid AAC packet limit');
  const reservedIndexBytes=Math.max(1048576,Math.ceil(maxFrames*64+1048576)),files=[];
  let cursor=0,finished=false,child=null,completion=null,errors='',failure=null;
  function check(){if(failure)throw failure;}
  return{
    append(file,{startFrame,endFrame,fps:rate}){
      if(finished||rate!==fps||startFrame!==cursor||!Number.isInteger(endFrame)||endFrame<=startFrame)throw Error('Video copy ranges are not contiguous');
      const pieces=Array.isArray(file)?file:[file];if(!pieces.length||pieces.some(piece=>typeof piece!=='string'||!piece))throw Error('Video copy has no input fragments');
      cursor=endFrame;files.push(...pieces.map(piece=>path.resolve(piece)));
    },
    async finish(expectedFrames){
      if(finished)throw Error('Video copy already finished');finished=true;
      if(cursor!==expectedFrames)throw Error('Video copy input does not cover the complete timeline');
      const started=performance.now(),list=path.join(path.dirname(output),`.${path.basename(output)}.${randomUUID()}.inputs`);
      let bytes=0;for(const file of files)bytes+=(await stat(file)).size;
      // concatf is a byte-concatenation protocol, so no input timestamp guesses
      // or extra H.264 encoding are introduced at round boundaries.
      await writeFile(list,files.map(file=>'file:'+file.replaceAll('\\','/')).join('\n')+'\n',{flag:'wx'});
      const priority=process.platform==='win32'?0:10;
      try{
        child=spawn(ffmpeg,['-hide_banner','-loglevel','warning','-nostdin','-y','-r',String(fps),'-f','h264','-i','concatf:'+list.replaceAll('\\','/'),'-i',audioFile,'-map','0:v:0','-map','1:a:0','-c','copy',...(audioPacketLimit!==null?['-frames:a',String(audioPacketLimit)]:[]),'-moov_size',String(reservedIndexBytes),output],{stdio:['ignore','ignore','pipe'],windowsHide:true});
        if(child.pid)try{setPriority(child.pid,priority)}catch{}
        child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-4000)});
        completion=new Promise(resolve=>{child.once('error',error=>{failure??=error;resolve()});child.once('close',code=>{if(code!==0)failure??=Error('Video/AAC copy mux failed: '+errors);resolve()})});
        await completion;check();return{frames:cursor,videoBytes:bytes,videoCopied:true,audioCopied:true,transport:'file-concat',...(audioPacketLimit!==null?{audioPacketLimit}:{}),reservedIndexBytes,priority,finishedSeconds:(performance.now()-started)/1000};
      }finally{await rm(list,{force:true});}
    },
    async close(){finished=true;if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await completion;},
  };
}
