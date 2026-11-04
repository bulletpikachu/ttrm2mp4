import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {terminateWindowsProcessTree} from '../src/offline/windows-process-tree.mjs';

assert.equal(process.platform,'win32');
const script=fileURLToPath(import.meta.url),mode=process.argv[2];
function launch(mode){return spawn(process.execPath,[script,mode],{windowsHide:true,stdio:['ignore','inherit','inherit','ipc']});}
if(mode==='leaf'){setInterval(()=>{},1000);process.send({pids:[process.pid]});}
else if(mode==='branch'){
  const leaf=launch('leaf');const [message]=await once(leaf,'message');process.send({pids:[process.pid,...message.pids]});
}else if(mode==='root'){
  const children=[launch('branch'),launch('branch')];const messages=await Promise.all(children.map(child=>once(child,'message')));
  process.send({pids:[process.pid,...messages.flatMap(([message])=>message.pids)]});
}else{
  const unrelated=launch('leaf'),owned=launch('root');let pids=[];
  try{
    await once(unrelated,'message');const [message]=await once(owned,'message');pids=message.pids;assert.equal(pids.length,5);
    const closed=once(owned,'close');await terminateWindowsProcessTree(owned);await closed;
    for(const pid of pids)assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH','Owned descendant exited');
    assert.doesNotThrow(()=>process.kill(unrelated.pid,0),'Unrelated sibling is still alive');
    await terminateWindowsProcessTree(owned);assert.doesNotThrow(()=>process.kill(unrelated.pid,0),'Repeated cleanup does not use a stale PID');
    console.log('PASS: worker, children and grandchildren exit; inherited pipes close; an unrelated sibling survives repeated cleanup.');
  }finally{await Promise.all([terminateWindowsProcessTree(owned),terminateWindowsProcessTree(unrelated)]);}
}
