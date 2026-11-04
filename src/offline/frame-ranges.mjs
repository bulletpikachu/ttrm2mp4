import assert from 'node:assert/strict';

export function validateFrameWindow(window){
  if(!window||!Number.isSafeInteger(window.startFrame)||window.startFrame<0||!(window.endFrame===null||Number.isSafeInteger(window.endFrame)&&window.endFrame>window.startFrame)||!Number.isSafeInteger(window.warmupFrames)||window.warmupFrames<0)throw Error('Invalid worker frame window');
  return{startFrame:window.startFrame,endFrame:window.endFrame,warmupFrames:window.warmupFrames};
}
export function makeFrameWindows(estimatedFrames,jobs,fps,{simulationWeight=0}={}){
  if(!Number.isSafeInteger(estimatedFrames)||estimatedFrames<1||!Number.isInteger(jobs)||jobs<1||jobs>8||!Number.isInteger(fps)||fps<1||fps>60||!Number.isFinite(simulationWeight)||simulationWeight<0||simulationWeight>10)throw Error('Invalid frame-window scheduling inputs');
  const alignment=fps*2,count=Math.min(jobs,Math.max(1,Math.floor(estimatedFrames/alignment))),windows=[];let start=0;
  const ratio=1/(1+simulationWeight),weights=Array.from({length:count},(_,i)=>ratio**i),total=weights.reduce((a,b)=>a+b,0);let cumulative=0;
  for(let i=0;i<count;i++){
    cumulative+=weights[i];
    const end=i===count-1?null:Math.max(start+alignment,Math.round(estimatedFrames*cumulative/total/alignment)*alignment);
    windows.push(validateFrameWindow({startFrame:start,endFrame:end,warmupFrames:alignment}));start=end;
  }
  return windows;
}
function checkLeader(leader){
  assert(leader.finished===true&&!leader.completedPrefix&&Number.isSafeInteger(leader.count)&&leader.count>0,'Frame windows require a complete leader');
  let cursor=0;for(const round of leader.timelineRounds){assert.equal(round.startFrame,cursor);assert(Number.isSafeInteger(round.endFrame)&&round.endFrame>cursor);cursor=round.endFrame;}
  assert.equal(cursor,leader.count);
}
export function expectedFrameFragments(leader,window){
  checkLeader(leader);window=validateFrameWindow(window);
  const end=Math.min(window.endFrame??leader.count,leader.count);
  return leader.timelineRounds.map(round=>({round:round.round,startFrame:Math.max(window.startFrame,round.startFrame),endFrame:Math.min(end,round.endFrame)})).filter(part=>part.endFrame>part.startFrame);
}
export function verifyFrameFragment(fragment,leader,window){
  const expected=expectedFrameFragments(leader,window).find(part=>part.round===fragment.round);
  assert(expected,'Fragment is outside the assigned frame window');
  assert.equal(fragment.fragment,true);assert.equal(fragment.audioFromLeader,true);assert.equal(fragment.pcmSha256,null);
  assert.equal(fragment.startFrame,expected.startFrame);assert.equal(fragment.endFrame,expected.endFrame);
  assert.equal(fragment.fps,leader.fps);assert.equal(fragment.sampleRate,leader.sampleRate);
  return expected;
}
export function verifyFrameWorker(worker,leader,window){
  checkLeader(leader);window=validateFrameWindow(window);assert.deepEqual(worker.frameWindow,window);
  const end=Math.min(window.endFrame??leader.count,leader.count),encoded=Math.max(0,end-window.startFrame),bounded=window.endFrame!==null&&window.endFrame<=leader.count;
  assert.equal(worker.count,end);assert.equal(worker.samples,Math.round(end/leader.fps*leader.sampleRate));
  assert.equal(worker.fps,leader.fps);assert.equal(worker.sampleRate,leader.sampleRate);
  assert.equal(worker.videoOnlyWorker,true);assert.equal(worker.audioOnly,false);assert.equal(worker.audioPCMHash,null);
  assert.equal(worker.encodedCount,encoded);assert.equal(worker.nativeWebGL.encoder.frames,encoded);
  assert.equal(worker.completedFrameWindow,bounded);assert.equal(worker.finished,!bounded);assert.equal(worker.completedPrefix,false);
  const timeline=leader.timelineRounds.filter(round=>round.startFrame<end).map(round=>({...round,endFrame:Math.min(round.endFrame,end)}));
  assert.deepEqual(worker.timelineRounds,timeline,'Worker must retain the complete simulated prefix, including a cropped final round');
  const parts=expectedFrameFragments(leader,window),actual=worker.rounds.map(part=>verifyFrameFragment(part,leader,window)).sort((a,b)=>a.startFrame-b.startFrame);
  assert.deepEqual(actual,parts,'Every assigned round fragment must be present exactly once');
  const warmStart=Math.max(0,window.startFrame-window.warmupFrames),warmEnd=Math.min(window.startFrame,leader.count);let cursor=warmStart;
  for(const record of [...worker.warmups].sort((a,b)=>a.firstFrame-b.firstFrame)){
    assert.equal(record.firstFrame,cursor);assert.equal(record.frames,record.lastFrame-record.firstFrame+1);assert(record.frames>0);cursor=record.lastFrame+1;
  }
  assert.equal(cursor,Math.max(warmStart,warmEnd),'Warmup must cover every requested preceding frame');
  return{startFrame:window.startFrame,endFrame:end,encodedFrames:encoded,simulatedFrames:end,warmupFrames:Math.max(0,warmEnd-warmStart),verified:true};
}
export function createFragmentCollector(leader){
  checkLeader(leader);const collected=new Map(),completed=new Set();
  return{
    add(fragment,window){
      const part=verifyFrameFragment(fragment,leader,window),round=leader.timelineRounds.find(round=>round.round===part.round);
      assert(!completed.has(part.round),'Round fragments arrived after completion');
      const parts=collected.get(part.round)||[];
      assert(!parts.some(old=>part.startFrame<old.endFrame&&part.endFrame>old.startFrame),'Overlapping or duplicate round fragments');
      parts.push(part);parts.sort((a,b)=>a.startFrame-b.startFrame);collected.set(part.round,parts);
      let cursor=round.startFrame;for(const item of parts){if(item.startFrame!==cursor)return null;cursor=item.endFrame;}
      if(cursor!==round.endFrame)return null;
      completed.add(part.round);return{...round,fragments:parts};
    },
    finish(){assert.equal(completed.size,leader.timelineRounds.length,'Fragments do not cover every complete round');return true;},
  };
}
