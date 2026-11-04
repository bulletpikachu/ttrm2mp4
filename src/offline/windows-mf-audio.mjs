// Media Foundation consumes complete 2,048-sample input blocks on the tested
// Windows encoder. Its drain can omit the final packet, so append a silent
// flush block as well. The caller validates and copies only the packet prefix
// covering the original PCM timeline. The original PCM hash excludes padding.
export function mediaFoundationAACArgs(pcm,output,sampleRate){
  if(sampleRate!==48000)throw Error('Windows Media Foundation AAC currently requires 48 kHz stereo PCM');
  return['-hide_banner','-loglevel','warning','-nostdin','-y','-f','f32le','-ar',String(sampleRate),'-ac','2','-i',pcm,
    '-vn','-af','apad=pad_len=2048,asetnsamples=n=2048:p=1','-c:a','aac_mf','-threads','1','-b:a','192k','-movflags','+faststart',output];
}

export function createMediaFoundationAACInspector(samples,sampleRate){
  if(sampleRate!==48000||!Number.isSafeInteger(samples)||samples<=0)throw Error('Invalid Media Foundation AAC timeline');
  const requiredPackets=Math.ceil(samples/1024);let packets=0,timeBase=false,rate=false,stereo=false;
  return{
    line(text){
      text=text.trim();if(!text)return;
      if(text.startsWith('#')){
        if(/^#tb 0:\s*1\/48000$/.test(text))timeBase=true;
        if(/^#sample_rate 0:\s*48000$/.test(text))rate=true;
        if(/^#channel_layout_name 0:\s*stereo$/.test(text))stereo=true;
        return;
      }
      const fields=text.split(',').map(field=>field.trim());
      if(packets<requiredPackets&&(fields[0]!=='0'||Number(fields[1])!==packets*1024||Number(fields[2])!==packets*1024||Number(fields[3])!==1024||Number(fields[4])<=0))throw Error('Media Foundation AAC packet timing does not match the PCM timeline');
      packets++;
    },
    finish(){
      if(!timeBase||!rate||!stereo||packets<requiredPackets)throw Error('Media Foundation AAC did not cover the complete stereo PCM timeline');
      return{encodedPackets:packets,requiredPackets,samples,paddingSamples:requiredPackets*1024-samples,verified:true};
    },
  };
}
