// Cache the browser decoder's exact Float32 output, never a second codec's
// interpretation. Keys include compressed bytes, resampling rate and Electron
// version. Both the metadata and PCM are validated before reuse.
(() => {
  if(typeof require!=='function')return;
  const fs=require('node:fs'),path=require('node:path'),{createHash,randomUUID}=require('node:crypto');
  const directory=window.__audioDecodeCacheDirectory;
  fs.mkdirSync(directory,{recursive:true});
  const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
  const metrics=window.__audioDecodeCacheMetrics={hits:0,misses:0,bytes:0,milliseconds:0};
  window.__installAudioDecodeCache=context=>{
    const decode=context.decodeAudioData.bind(context);
    context.decodeAudioData=(input,success,failure)=>{
      const start=performance.now();
      const promise=(async()=>{
        const inputSha256=digest(Buffer.from(input));
        const key=`${inputSha256}-${context.sampleRate}-${process.versions.electron}-v1`;
        const metaFile=path.join(directory,key+'.json'),pcmFile=path.join(directory,key+'.f32');
        if(fs.existsSync(metaFile)){
          const meta=JSON.parse(fs.readFileSync(metaFile,'utf8')),pcm=fs.readFileSync(pcmFile);
          if(meta.inputSha256!==inputSha256||meta.sampleRate!==context.sampleRate||!Number.isSafeInteger(meta.length)||meta.length<1||!Number.isSafeInteger(meta.channels)||meta.channels<1||meta.channels>32||pcm.length!==meta.length*meta.channels*4||digest(pcm)!==meta.pcmSha256)throw Error('Invalid decoded audio cache: '+key);
          const buffer=context.createBuffer(meta.channels,meta.length,meta.sampleRate);
          const data=new Float32Array(pcm.buffer,pcm.byteOffset,pcm.length/4);
          for(let channel=0;channel<meta.channels;channel++)buffer.copyToChannel(data.subarray(channel*meta.length,(channel+1)*meta.length),channel);
          structuredClone(input,{transfer:[input]});
          metrics.hits++;metrics.bytes+=pcm.length;return buffer;
        }
        metrics.misses++;
        const buffer=await decode(input),channels=buffer.numberOfChannels,length=buffer.length;
        const pcm=Buffer.allocUnsafe(channels*length*4);
        for(let channel=0;channel<channels;channel++){
          const data=buffer.getChannelData(channel);
          Buffer.from(data.buffer,data.byteOffset,data.byteLength).copy(pcm,channel*length*4);
        }
        const meta={inputSha256,pcmSha256:digest(pcm),sampleRate:buffer.sampleRate,length,channels};
        const suffix=`.${process.pid}.${randomUUID()}.tmp`;
        fs.writeFileSync(pcmFile+suffix,pcm);fs.renameSync(pcmFile+suffix,pcmFile);
        fs.writeFileSync(metaFile+suffix,JSON.stringify(meta));fs.renameSync(metaFile+suffix,metaFile);
        return buffer;
      })();
      promise.then(()=>{metrics.milliseconds+=performance.now()-start},error=>{window.__audioDecodeCacheFailure=error.stack||String(error)});
      if(success||failure)promise.then(buffer=>success?.(buffer),error=>failure?.(error));
      return promise;
    };
  };
})();
