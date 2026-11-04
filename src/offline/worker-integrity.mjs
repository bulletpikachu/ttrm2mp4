import {createHash} from 'node:crypto';

// Every actually simulated prefix, including unrendered round gaps, must match
// the independent complete leader PCM. All delivered round ranges are also
// checked separately before the master mux is accepted.
export function verifyWorkerTimeline(worker,leader){
  if(leader.finished!==true||leader.completedPrefix||!Number.isInteger(leader.count)||leader.count<=0||!Number.isInteger(leader.fps)||leader.fps<=0||!Number.isInteger(leader.sampleRate)||leader.sampleRate<=0)throw Error('Prefix verification requires a complete leader PCM timeline');
  if(!Number.isInteger(worker.count)||worker.count<=0||worker.count>leader.count||worker.fps!==leader.fps||worker.sampleRate!==leader.sampleRate||worker.samples!==Math.round(worker.count/leader.fps*leader.sampleRate))throw Error('Worker prefix frame/sample counts differ from leader');
  const expected=leader.timelineRounds.filter(round=>round.endFrame<=worker.count);
  if(!expected.length||expected.at(-1).endFrame!==worker.count||JSON.stringify(worker.timelineRounds)!==JSON.stringify(expected))throw Error('Worker prefix is not an exact complete-round timeline prefix');
  const prefix=worker.count<leader.count;
  if(prefix?(worker.completedPrefix!==true||worker.finished!==false||!worker.selectedRounds?.length||Math.max(...worker.selectedRounds)!==expected.at(-1).round):(worker.finished!==true||worker.completedPrefix))throw Error('Worker prefix completion state is invalid');
  return{startFrame:0,endFrame:worker.count,samples:worker.samples,verified:true,completeMatch:!prefix};
}
export function verifyWorkerPrefix(worker,leader,leaderPCM){
  const timeline=verifyWorkerTimeline(worker,leader);
  if(!Buffer.isBuffer(leaderPCM)||leaderPCM.length!==leader.samples*8)throw Error('Prefix verification requires a complete leader PCM timeline');
  const pcmSha256=createHash('sha256').update(leaderPCM.subarray(0,worker.samples*8)).digest('hex');
  if(worker.audioPCMHash!==pcmSha256)throw Error('Worker prefix PCM differs from the complete leader PCM');
  return{...timeline,pcmSha256};
}
