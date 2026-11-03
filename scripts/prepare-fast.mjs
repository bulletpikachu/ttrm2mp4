import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const replay=process.argv[2];
if(!replay||process.argv.length!==3)throw Error('Usage: npm run prepare-fast -- example.ttrm (prepare-client must already be complete)');
async function run(script,args=[]){const child=spawn(process.execPath,[path.join(root,script),...args],{cwd:root,stdio:'inherit'});const[code]=await once(child,'exit');if(code!==0)throw Error(`${script} failed (${code})`);}
await run('scripts/prepare-native.mjs');
const directory=await mkdtemp(path.join(tmpdir(),'replay-prepare-fast-'));
try{
  await run('src/render-fast.mjs',[path.resolve(replay),path.join(directory,'warmup.mp4'),'--duration','0.1']);
}finally{await rm(directory,{recursive:true,force:true})}
console.log('Native modules and exact browser audio cache are ready. Future exports use local files.');
