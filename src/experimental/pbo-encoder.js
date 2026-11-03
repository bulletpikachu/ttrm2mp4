// Original Chromium WebGL -> asynchronous GPU pixel-pack ring -> CPU x264.
// Readbacks and codec callbacks are ordered and bounded independently.
window.__createRawEncoder = ({width,height,fps}) => {
  const options=window.__nativeEncoderOptions,fs=require('node:fs'),path=require('node:path');
  const codec=require(options.directory+'/x264-surface-encoder.node');
  const immediate=require('node:timers').setImmediate;
  window.__installNativeAudio(options);
  const threads=Number(process.env.REPLAY_X264_THREADS||8),slots=Number(process.env.REPLAY_PBO_SLOTS||8);
  if(!Number.isInteger(threads)||threads<1||threads>32||!Number.isInteger(slots)||slots<2||slots>32)throw Error('Invalid codec thread count or GPU ring depth');
  const copyMethod=process.env.REPLAY_PBO_COPY||'pbo';
  if(!['pbo','videoframe','worker'].includes(copyMethod))throw Error('REPLAY_PBO_COPY must be pbo, videoframe or worker');
  const pack=window.__createNV12Packer(width,height,{slots,copyMethod});
  const held=new Set(),metrics={submitMs:0,readbackMs:0,copyMs:0,waitMs:0,segments:[],slots,copyMethod,slowSubmits:[],slowReadbacks:[]};
  let index=0,segmentStart=0,written=0,opened=false,failure=null,sampleFrame=null;
  const wall=__timeline.wallNow,yieldIO=()=>new Promise(resolve=>immediate(resolve));
  function check(){if(failure)throw failure}
  function open(){
    if(opened)return;
    codec.open(width,height,fps,12000000,options.output,(id,status)=>{
      if(!held.delete(id))failure=Error('Unexpected byte-encoder completion '+id);
      if(status)failure=Error('Byte-encoder failure '+status);
    });opened=true;segmentStart=index;
  }
  function collect(){
    check();let count=0;
    while(pack.pendingCount&&held.size<32){
      const slot=pack.peek();if(!pack.ready(slot))break;
      let time=wall();const data=pack.read(slot);const readMs=wall()-time;metrics.readbackMs+=readMs;if(readMs>100&&metrics.slowReadbacks.length<20)metrics.slowReadbacks.push({index:slot.meta.index,ms:readMs});
      const meta=slot.meta;
      if(meta.sourceFormat)metrics.sourceFormat=meta.sourceFormat;
      if(meta.sampleFrame!==null&&options.qualitySamples){
        let sample=data;if(copyMethod==='videoframe'){sample=new Uint8Array(width*height*3/2);for(let i=0,j=0;i<data.length;i+=4){sample[j++]=data[i+(meta.bgr?2:0)];sample[j++]=data[i+1];sample[j++]=data[i+(meta.bgr?0:2)];}}
        fs.writeFileSync(path.join(options.qualitySamples,`frame-${String(meta.sampleFrame).padStart(6,'0')}.nv12`),sample,{flag:options.overwrite?'w':'wx'});
      }
      held.add(meta.index);time=wall();codec[copyMethod==='videoframe'?'encodePackedRGB':'encodeBytes'](data,meta.index,meta.key,!!meta.bgr);metrics.copyMs+=wall()-time;
      pack.release(slot);count++;
    }
    return count;
  }
  async function waitUntil(condition){
    const start=wall();while(!condition()){collect();check();if(wall()-start>30000)throw Error('GPU/codec pipeline stopped making progress');await yieldIO()}
    metrics.waitMs+=wall()-start;
  }
  async function flush(){
    if(!opened)return;
    collect();await waitUntil(()=>pack.pendingCount===0);
    metrics.segments.push(codec.stats());const frames=codec.close();opened=false;
    if(frames!==index-segmentStart)throw Error(`Byte-encoder wrote ${frames} frames, expected ${index-segmentStart}`);
    written+=frames;await waitUntil(()=>held.size===0);await window.__commitNativeSegment();check();
  }
  open();
  return {
    async beforeFrame(){collect();if(!pack.freeCount)await waitUntil(()=>pack.freeCount>0)},
    capture:canvas=>canvas,
    qualitySample(_draw,count){sampleFrame=count},
    async write(canvas){check();const start=wall();pack.submit(canvas,{index,key:index===segmentStart||index%(fps*2)===0,sampleFrame});sampleFrame=null;const ms=wall()-start;if(ms>100&&metrics.slowSubmits.length<20)metrics.slowSubmits.push({index,ms});index++;metrics.submitMs+=ms;collect()},
    beginRound:open,flushRound:flush,
    async finish(){await flush();pack.close();if(written!==index)throw Error('PBO frame count mismatch');window.__pboEncoderResult={frames:written,metrics,threads,preset:'ultrafast',crf:18,ordered:true}},
  };
};
