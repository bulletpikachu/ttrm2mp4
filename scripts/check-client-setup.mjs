import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,readdir,access,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {validatePreparedClient,publishPreparedClient} from '../src/offline/prepare-client.mjs';
import {ClientSetup,clientReady} from '../desktop/setup.mjs';
const temp=await mkdtemp(path.join(tmpdir(),'replay-client-setup-check-'));
const hash=body=>createHash('sha256').update(body).digest('hex');
try{
  const directory=path.join(temp,'fixture');await mkdir(path.join(directory,'objects'),{recursive:true});
  const game='GET https://tetr.io/js/tetrio.js',index='GET https://tetr.io/';
  const manifest={format:1,game,entries:{[index]:{hash:hash('html'),status:200,type:'text/html'},[game]:{hash:hash('script'),status:200,type:'application/javascript'}}};
  for(const body of ['html','script'])await writeFile(path.join(directory,'objects',hash(body)),body);
  await writeFile(path.join(directory,'manifest.json'),JSON.stringify(manifest));
  await validatePreparedClient(directory,{verifyPatch:false});assert(await clientReady(directory));
  await writeFile(path.join(directory,'objects',hash('script')),'corrupted');
  await assert.rejects(validatePreparedClient(directory,{verifyPatch:false}),/integrity/);
  const old=path.join(temp,'old'),stage=path.join(temp,'stage');await mkdir(old);await mkdir(stage);
  await writeFile(path.join(old,'marker'),'old');await writeFile(path.join(stage,'marker'),'new');
  await publishPreparedClient(stage,old);assert.equal(await readFile(path.join(old,'marker'),'utf8'),'new');
  await assert.rejects(publishPreparedClient(path.join(temp,'missing'),old));
  assert.equal(await readFile(path.join(old,'marker'),'utf8'),'new','A failed replacement restores the existing cache');
  const replay=path.join(temp,'sample.ttrm');await writeFile(replay,JSON.stringify({replay:{rounds:[[{replay:{frames:60,events:[]}},{replay:{frames:60,events:[]}}]]}}));
  const events=[];
  const setup=new ClientSetup({root:temp,executable:process.execPath,userData:path.join(temp,'data'),spawnWorker:(_exe,args,options)=>spawn(process.execPath,['-e',`
    const fs=require('node:fs'),path=require('node:path'),directory=process.argv[1],hash='a'.repeat(64);
    fs.mkdirSync(path.join(directory,'objects'),{recursive:true});fs.writeFileSync(path.join(directory,'objects',hash),'game');
    fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify({format:1,game:'game',entries:{game:{hash}}}));
    process.send({type:'setup-event',event:{type:'setup-progress',stage:'Download',progress:.5}});
    process.send({type:'setup-event',event:{type:'setup-ready',directory}});process.disconnect();
  `,args[2]],options)});
  setup.on('event',event=>events.push(event));const ready=setup.start(replay);
  assert.throws(()=>setup.start(replay),/already running/);
  const selected=await ready;assert(await clientReady(selected));assert(events.some(e=>e.type==='setup-completed'));assert.equal(setup.active,null);
  const failed=new ClientSetup({root:temp,executable:process.execPath,userData:path.join(temp,'data'),spawnWorker:(_exe,args,options)=>spawn(process.execPath,['-e',`
    const fs=require('node:fs');fs.mkdirSync(process.argv[1],{recursive:true});
    process.send({type:'setup-event',event:{type:'setup-error',message:'Unsupported game version'}});process.exitCode=1;process.disconnect();
  `,args[2]],options)});
  await assert.rejects(failed.start(replay),/Unsupported game version/);
  assert(await clientReady(selected),'A failed refresh preserves the previous cache');
  assert.equal((await readdir(path.join(temp,'data/clients'))).length,1,'Failed attempts are removed');
  let downloading;
  const started=new Promise(resolve=>{downloading=resolve;});
  const cancelled=new ClientSetup({root:temp,executable:process.execPath,userData:path.join(temp,'data'),spawnWorker:(_exe,args,options)=>spawn(process.execPath,['-e',`
    const fs=require('node:fs');fs.mkdirSync(process.argv[1],{recursive:true});fs.writeFileSync(process.argv[1]+'/partial','partial');
    process.send({type:'setup-event',event:{type:'setup-progress',bytes:1}});setInterval(()=>{},1000);
  `,args[2]],options)});
  cancelled.on('event',event=>{if(event.type==='setup-progress'&&event.bytes)downloading();});
  const cancelling=cancelled.start(replay);const rejection=assert.rejects(cancelling,/cancelled/);
  await started;await cancelled.cancel();await rejection;
  assert(await clientReady(selected));assert.equal((await readdir(path.join(temp,'data/clients'))).length,1,'Cancelled downloads leave no partial cache');
  console.log('PASS: downloaded-file integrity, atomic replacement/rollback, isolated refresh, progress, activation, failure and cancellation cleanup.');
}finally{await rm(temp,{recursive:true,force:true});}
