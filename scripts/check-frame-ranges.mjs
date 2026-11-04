import assert from 'node:assert/strict';
import {makeFrameWindows,validateFrameWindow,expectedFrameFragments,verifyFrameWorker,createFragmentCollector} from '../src/offline/frame-ranges.mjs';
const leader={finished:true,completedPrefix:false,count:12,fps:60,sampleRate:48000,timelineRounds:[{round:1,startFrame:0,endFrame:3},{round:2,startFrame:3,endFrame:8},{round:3,startFrame:8,endFrame:12}]};
const windows=[{startFrame:0,endFrame:5,warmupFrames:2},{startFrame:5,endFrame:9,warmupFrames:2},{startFrame:9,endFrame:null,warmupFrames:2}];
function worker(window){
  const end=Math.min(window.endFrame??12,12),bounded=window.endFrame!==null&&window.endFrame<=12,encoded=Math.max(0,end-window.startFrame),first=Math.max(0,window.startFrame-window.warmupFrames),last=Math.min(window.startFrame,12);
  return{frameWindow:window,count:end,samples:end*800,fps:60,sampleRate:48000,videoOnlyWorker:true,audioOnly:false,audioPCMHash:null,encodedCount:encoded,nativeWebGL:{encoder:{frames:encoded}},completedFrameWindow:bounded,finished:!bounded,completedPrefix:false,
    timelineRounds:leader.timelineRounds.filter(r=>r.startFrame<end).map(r=>({...r,endFrame:Math.min(r.endFrame,end)})),
    rounds:expectedFrameFragments(leader,window).map(part=>({...part,fragment:true,audioFromLeader:true,pcmSha256:null,fps:60,sampleRate:48000})),
    warmups:last>first?[{round:1,firstFrame:first,lastFrame:last-1,frames:last-first}]:[]};
}
const workers=windows.map(worker);
for(let i=0;i<windows.length;i++)assert.equal(verifyFrameWorker(workers[i],leader,windows[i]).verified,true);
for(const window of [{startFrame:9,endFrame:12,warmupFrames:2},{startFrame:9,endFrame:18,warmupFrames:2},{startFrame:15,endFrame:20,warmupFrames:2},{startFrame:13,endFrame:null,warmupFrames:2}])verifyFrameWorker(worker(window),leader,window);
const collector=createFragmentCollector(leader),complete=[];
for(const i of [2,0,1])for(const part of workers[i].rounds){const result=collector.add(part,windows[i]);if(result)complete.push(result);}
assert.equal(collector.finish(),true);assert.deepEqual(complete.sort((a,b)=>a.round-b.round).map(({round,startFrame,endFrame})=>({round,startFrame,endFrame})),leader.timelineRounds);
assert.equal(complete.find(r=>r.round===2).fragments.length,2,'An internal round cut assembles both fragments');
assert.throws(()=>collector.add(workers[0].rounds[0],windows[0]),/after completion/);
assert.throws(()=>createFragmentCollector(leader).finish(),/cover every/);
const overlap=createFragmentCollector(leader);overlap.add(workers[0].rounds[1],windows[0]);
const overlapping={startFrame:4,endFrame:8,warmupFrames:2};assert.throws(()=>overlap.add(worker(overlapping).rounds[0],overlapping),/Overlapping/);
for(const edit of [w=>w.count++,w=>w.samples--,w=>w.encodedCount--,w=>w.nativeWebGL.encoder.frames--,w=>w.rounds.pop(),w=>w.rounds.push(w.rounds[0]),w=>w.rounds[0].startFrame++,w=>w.timelineRounds.pop(),w=>w.timelineRounds[0].endFrame--,w=>w.completedPrefix=true,w=>w.finished=true,w=>w.completedFrameWindow=false,w=>w.audioPCMHash='0'.repeat(64),w=>w.warmups=[],w=>w.warmups[0].firstFrame++]){
  const altered=structuredClone(workers[1]);edit(altered);assert.throws(()=>verifyFrameWorker(altered,leader,windows[1]));
}
for(const estimate of [1,119,120,241,19339,99999])for(const jobs of [1,2,4,8])for(const simulationWeight of [0,.65,3]){
  const result=makeFrameWindows(estimate,jobs,60,{simulationWeight});assert.equal(result[0].startFrame,0);assert.equal(result.at(-1).endFrame,null);
  for(let i=0;i<result.length;i++){validateFrameWindow(result[i]);if(i)assert.equal(result[i].startFrame,result[i-1].endFrame);}
}
for(const bad of [{startFrame:-1,endFrame:null,warmupFrames:2},{startFrame:1,endFrame:1,warmupFrames:2},{startFrame:0,endFrame:2,warmupFrames:-1}])assert.throws(()=>validateFrameWindow(bad),/Invalid/);
for(const simulationWeight of [-1,11,NaN,Infinity])assert.throws(()=>makeFrameWindows(1000,3,60,{simulationWeight}),/Invalid/);
console.log('PASS: internal-round cuts, exact-end and overshot windows, empty windows, out-of-order assembly, complete warmup, native counts and malformed/overlapping/gapped coverage rejection.');
