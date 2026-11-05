// Hold all proposed NVENC sessions open together before releasing any of them.
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const [mode,countArg,widthArg,heightArg,fpsArg,directory]=process.argv.slice(2);
if(process.platform!=='win32'||process.arch!=='x64')throw Error('Windows x64 required');
if(mode==='--session'){
  const require=createRequire(import.meta.url);
  const codec=require('../.native-deps/windows-gpu/windows-encoder.node');
  const timer=setTimeout(()=>{console.error('NVENC session probe timed out');process.exit(1)},45000);
  try{
    const {createCanvas}=await import('../.native-deps/node-webgl-windows/dist/index.js');
    const canvas=createCanvas(Number(widthArg),Number(heightArg)),gl=canvas.getContext('webgl2');
    if(!gl)throw Error('Native WebGL 2 unavailable');
    codec.initialize(gl._n._replayEGL(),Number(widthArg),Number(heightArg),Number(fpsArg));
    codec.open(path.join(directory,`session-${countArg}.h264`));
    await new Promise((resolve,reject)=>{
      process.once('message',resolve);process.once('disconnect',()=>reject(Error('Session probe disconnected')));
      process.send({ready:true});
    });
    codec.close();
  }finally{codec.shutdown();clearTimeout(timer);if(process.connected)process.disconnect();}
}else{
  const count=Number(countArg);
  if(mode!=='--group'||!Number.isInteger(count)||count<1||count>8)throw Error('Invalid session count');
  const children=[],closed=[];
  try{
    const ready=Array.from({length:count},(_,i)=>{
      const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--session',String(i),widthArg,heightArg,fpsArg,directory],{env:process.env,stdio:['ignore','ignore','inherit','ipc'],windowsHide:true});
      children.push(child);
      closed.push(new Promise(resolve=>{child.once('error',resolve);child.once('close',resolve)}));
      return new Promise((resolve,reject)=>{
        child.once('error',reject);
        child.once('message',message=>message.ready?resolve():reject(Error('Invalid session response')));
        child.once('close',code=>reject(Error(`NVENC session startup failed (${code})`)));
      });
    });
    await Promise.all(ready);
    // No session can close before every session has successfully opened.
    for(const child of children)child.send({release:true});
    await Promise.all(closed);
    if(children.some(child=>child.exitCode!==0))throw Error('NVENC session cleanup failed');
  }finally{
    for(const child of children)if(child.exitCode===null)child.kill();
    await Promise.all(closed);
  }
}
