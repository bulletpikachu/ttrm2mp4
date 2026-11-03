#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const args=process.argv.slice(2);
if(args.includes('--help')){
  console.log('Usage: npm run render-fast -- input.ttrm output.mp4 [--overwrite] [--duration seconds]\n\nOffline Apple Silicon native export at 1920×1080 / 60 fps, with continuous audio\nand each round saved as it finishes. Run prepare-client and prepare-fast once.\nMeasured full command: 185.63 seconds exported in 17.84 seconds (10.41×).\nSpeed depends on hardware, replay complexity, system load and a prepared audio cache.\nKeep inputs/assets and the output destination local for the best performance.');
}else{
  if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('render-fast currently requires Apple Silicon macOS');
  if(Number(process.versions.node.split('.')[0])<22)throw Error('render-fast requires Node.js 22 or newer');
  for(const name of ['angle-surface','x264-surface-encoder','audio-mixer'])try{await access(new URL(`./experimental/native/${name}.node`,import.meta.url))}catch{throw Error('Native modules are missing. Run npm run prepare-native before exporting.');}
  const child=spawn(process.execPath,[fileURLToPath(new URL('./render.mjs',import.meta.url)),...args,'--engine','electron','--native-webgl','--native-encoder','--export-rounds','--deterministic'],{stdio:'inherit',env:{
    REPLAY_GL_BATCH:'1',REPLAY_GL_ASYNC:'1',REPLAY_GL_POOL:'1',REPLAY_GL_DEFER_FLUSH:'1',REPLAY_GL_SPECIALIZE:'1',REPLAY_FAST_YIELD:'1',REPLAY_STREAM_AUDIO:'1',REPLAY_STREAM_MUX:'1',REPLAY_NATIVE_GL_TRUSTED:'1',REPLAY_X264_THREADS:'16',REPLAY_ENCODER_QOS:'1',REPLAY_CODEC_WORKER_QOS:'initiated',REPLAY_DIRECT_TEXTURE:'1',REPLAY_FORMAT_CACHE:'1',REPLAY_IMPLICIT_RESOLVE:'1',REPLAY_PACKED_NV12:'1',REPLAY_GPU_BATCH:'4',REPLAY_AUDIO_DECODE_CACHE:'1',REPLAY_FINAL_AUDIO_REUSE:'1',REPLAY_NATIVE_INTERLEAVE:'1',REPLAY_OVERLAP_ROUND_AUDIO:'1',REPLAY_WAIT_TEXTURES:'1',REPLAY_RESERVE_MOOV:'1',...process.env,
  }});
  const interrupt=()=>child.kill('SIGINT'),terminate=()=>child.kill('SIGTERM');
  process.once('SIGINT',interrupt);process.once('SIGTERM',terminate);
  child.once('error',error=>{console.error(error.message);process.exitCode=1});
  child.once('exit',(code,signal)=>{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',terminate);process.exitCode=code??(signal?1:0)});
}
