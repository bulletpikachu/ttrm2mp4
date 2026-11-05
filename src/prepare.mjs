#!/usr/bin/env node
import path from 'node:path';
import {parseArgs} from 'node:util';
import {prepareClient} from './offline/prepare-client.mjs';
const {values:options,positionals}=parseArgs({allowPositionals:true,options:{chrome:{type:'string'},client:{type:'string',default:'client'},engine:{type:'string',default:'chrome'},software:{type:'boolean'},help:{type:'boolean'}}});
const usage='Usage: npm run prepare-client -- replay.ttrm [--client PATH] [--engine chrome|electron] [--chrome PATH] [--software]';
if(options.help)console.log(usage);
else{
  if(positionals.length!==1||!['chrome','electron'].includes(options.engine))throw Error(usage);
  const abort=new AbortController();const stop=()=>abort.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try{
    const result=await prepareClient({replayPath:path.resolve(positionals[0]),directory:path.resolve(options.client),engine:options.engine,chrome:options.chrome,software:options.software,signal:abort.signal,onProgress:event=>console.log(`${event.stage} (${event.files} files)`)});
    console.log(`Ready: ${result.directory}`);
  }catch(error){console.error(error.message);process.exitCode=1;}
  finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
