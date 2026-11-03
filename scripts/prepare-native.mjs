import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {access,mkdir} from 'node:fs/promises';
import {availableParallelism} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {patchX264QoS} from './patch-x264-qos.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('The experimental native pipeline currently requires Apple Silicon macOS');
const source=process.env.REPLAY_X264_SOURCE||path.join(root,'.native-deps/x264');
const revision='0480cb05fa188d37ae87e8f4fd8f1aea3711f7ee';
async function run(command,args,cwd=root){const child=spawn(command,args,{cwd,stdio:'inherit'});const[code]=await once(child,'exit');if(code!==0)throw Error(`${command} failed (${code})`);}
try{await access(path.join(source,'x264.h'))}catch{
  await mkdir(source,{recursive:true});
  await run('git',['init'],source);
  await run('git',['fetch','--depth','1','https://code.videolan.org/videolan/x264.git',revision],source);
  await run('git',['checkout','--detach','FETCH_HEAD'],source);
}
await patchX264QoS(source);
try{await access(path.join(source,'config.mak'))}catch{
  await run('./configure',['--enable-static','--enable-pic','--disable-cli','--disable-opencl'],source);
}
await run('make',['-j',String(Math.min(8,availableParallelism()))],source);
process.env.REPLAY_X264_SOURCE=source;
for(const script of ['build-angle-surface.mjs','build-surface-planes.mjs','build-x264-surface.mjs','build-audio-mixer.mjs','build-central-encoder.mjs'])await run(process.execPath,[path.join(root,'scripts',script)]);
console.log('Native modules built. Rendering uses local files and disables browser networking.');
