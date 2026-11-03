// Shared exact PCM mixer/file writer for native CPU codec experiments.
window.__installNativeAudio = options => {
  const fs=require('node:fs'),mixer=require(options.directory+'/audio-mixer.node');
  window.__verifyNativeMix=process.env.REPLAY_VERIFY_AUDIO==='1';
  window.__traceAudioGraph=process.env.REPLAY_TRACE_EFFECTS==='1';
  window.__nativeMixEffects=(audio,first,last)=>{
    const effects=[];
    for(const effect of window.__offlineSfx){
      const source=effect.buffer,eventStart=Math.max(0,Math.round(effect.time*audio.sampleRate));
      const start=Math.max(first,eventStart),end=Math.min(last,Math.ceil((effect.time+effect.length/effect.rate)*audio.sampleRate),Math.ceil(effect.stop*audio.sampleRate));if(start>=end)continue;
      const pan=Math.max(-1,Math.min(1,effect.pan)),mono=source.numberOfChannels===1;
      effects.push({left:source.getChannelData(0),right:source.getChannelData(mono?0:1),eventStart,start,end,rate:effect.rate*source.sampleRate/audio.sampleRate,offset:effect.offset*source.sampleRate,gain:effect.gain,kind:mono?0:pan<=0?1:2,a:mono?Math.cos((pan+1)*Math.PI/4):pan<=0?Math.cos((pan+1)*Math.PI/2):Math.cos(pan*Math.PI/2),b:mono?Math.sin((pan+1)*Math.PI/4):pan<=0?Math.sin((pan+1)*Math.PI/2):Math.sin(pan*Math.PI/2)});
    }
    mixer.mix({left:audio.getChannelData(0),right:audio.getChannelData(1),first,last,effects});
  };
  const hash=require('node:crypto').createHash('sha256');window.__nativePCMHash=()=>hash.digest('hex');
  window.__writeNativePCM=(pcm,kind)=>{const bytes=Buffer.from(pcm.buffer,pcm.byteOffset,pcm.byteLength);fs.appendFileSync(kind==='round'?options.roundAudio:options.audio,bytes);if(kind==='master')hash.update(bytes)};
  if(process.env.REPLAY_NATIVE_INTERLEAVE==='1')window.__writeNativeAudio=(buffer,first,last,kind)=>window.__writeNativePCM(mixer.interleave(buffer.getChannelData(0),buffer.getChannelData(1),first,last),kind);
};
