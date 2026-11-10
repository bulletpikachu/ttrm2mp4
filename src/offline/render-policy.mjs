import {availableParallelism,freemem,totalmem} from 'node:os';

export function hostResources() {
  return {cores:availableParallelism(),memoryBytes:Math.min(freemem(),totalmem())};
}
export function resourceDefaults({cores,memoryBytes},width=1920,height=1080) {
  const cpu=Math.max(1,Math.floor(cores));
  const gib=1024**3, scale=Math.max(1,width*height/(1920*1080));
  // Reserve memory for the OS/audio leader, and budget 2 GiB per 1080p worker.
  const memoryWorkers=Math.max(1,Math.floor((memoryBytes-2*gib)/(2*gib*scale)));
  return {
    jobs:Math.max(1,Math.min(3,Math.floor(cpu/2),memoryWorkers)),
    nativeThreads:Math.max(1,Math.min(16,cpu-2,Math.floor(memoryBytes/(128*1024**2*scale)))),
    portableThreads:Math.max(1,Math.min(8,cpu-1,Math.floor(memoryBytes/(128*1024**2*scale)))),
  };
}
export function positiveInteger(value,name,max) {
  const n=Number(value);
  if(!Number.isSafeInteger(n)||n<1||n>max)throw Error(`${name} must be an integer from 1 to ${max}`);
  return n;
}
// Consume only launcher options; preserve all renderer arguments and their order.
export function extractOptions(args,names) {
  const values={},rest=[];
  for(let i=0;i<args.length;i++){
    if(args[i]==='--'){rest.push(...args.slice(i));break;}
    const match=/^--([^=]+)(?:=(.*))?$/.exec(args[i]);
    if(!match||!names.includes(match[1])){rest.push(args[i]);continue;}
    const value=match[2]??args[++i];
    if(value===undefined||value.startsWith('--'))throw Error(`--${match[1]} requires a value`);
    if(values[match[1]]!==undefined)throw Error(`--${match[1]} was specified more than once`);
    values[match[1]]=value;
  }
  return {values,args:rest};
}
export function optionValue(args,name,fallback) {
  const {values}=extractOptions(args,[name]);return values[name]??fallback;
}
export function nativeOptionsSupported(args,backend) {
  const common=new Set(['width','height','fps','client','appearance','overwrite','report','export-rounds','deterministic','quality-samples','quality-interval']);
  if(backend==='mac'){for(const name of ['duration','round','profile'])common.add(name);}
  return args.every(arg=>!arg.startsWith('--')||common.has(arg.slice(2).split('=')[0]));
}
export async function selectBackend({requested,platform,arch,args,probe,threadsRequested=false}) {
  if(!['auto','portable','mac','windows-nvidia'].includes(requested))throw Error('backend must be auto, portable, mac, or windows-nvidia');
  if(requested==='portable')return {backend:'portable',reason:'Portable backend requested'};
  const native=platform==='darwin'&&arch==='arm64'?'mac':platform==='win32'&&arch==='x64'?'windows-nvidia':null;
  if(requested!=='auto'&&requested!==native)throw Error(`${requested} is unavailable on ${platform}/${arch}`);
  if(!native)return {backend:'portable',reason:`No native backend for ${platform}/${arch}`};
  if(native==='windows-nvidia'&&threadsRequested){
    if(requested!=='auto')throw Error('--threads applies to CPU encoding; Windows NVENC uses --jobs instead');
    return {backend:'portable',reason:'CPU thread override requested; using the portable CPU-capable backend'};
  }
  if(!nativeOptionsSupported(args,native)){
    if(requested!=='auto')throw Error('These options require --backend portable (use render-portable --help for options)');
    return {backend:'portable',reason:'Requested options require the portable backend'};
  }
  try {await probe(native);return {backend:native,reason:'Native startup export passed'};}
  catch(error){
    if(error.cancelled)throw error;
    if(requested!=='auto')throw Error(`${native} startup check failed: ${error.message}`);
    return {backend:'portable',reason:`Native backend unavailable: ${error.message}`};
  }
}

// Probe all requested sessions together, then reduce automatic concurrency only.
export async function probeWorkerCount({jobs,explicit=false,probe,probeGroup,onRetry=()=>{}}) {
  while(true){
    const checks=await Promise.allSettled(probeGroup?[probeGroup(jobs)]:Array.from({length:jobs},(_,i)=>probe(i,jobs)));
    const cancelled=checks.find(check=>check.status==='rejected'&&check.reason.cancelled);
    if(cancelled)throw cancelled.reason;
    const failure=checks.find(check=>check.status==='rejected');
    if(!failure)return jobs;
    if(explicit||jobs===1)throw failure.reason;
    onRetry(--jobs);
  }
}

// The audited D3D11 configuration, shared by startup checks and the launcher.
export function windowsFastEnvironment(env=process.env) {
  return { ...env,
      NODE_WEBGL_BACKEND: 'd3d11', REPLAY_WINDOWS_NVIDIA_ADAPTER: '1',
      REPLAY_WINDOWS_GPU_BATCH: '4', REPLAY_WINDOWS_CAVLC: '1',
      REPLAY_V8_FLAGS: '--max-valid-polymorphic-map-count=16', REPLAY_WINDOWS_COMPOSE_FAST: '1',
      REPLAY_WINDOWS_DIRECT_TEXTURE: '1',
      REPLAY_WINDOWS_MF_AUDIO: '1', REPLAY_WINDOWS_NATIVE_CLIENT: '1', REPLAY_WINDOWS_AUDIO_PARTICLES: '1',
      REPLAY_WINDOWS_D3D12: '0', REPLAY_WINDOWS_COMPUTE: '0', REPLAY_WINDOWS_COMPUTE_INPLACE: '0',
      REPLAY_WINDOWS_PENDING: '4', REPLAY_WINDOWS_SURFACES: '16', REPLAY_WINDOWS_FRAME_RANGES: '0',
    };
}
