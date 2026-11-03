window.__exportMovie = async function ({ fps, width, height, limitSeconds, maxSeconds, roundCount, queue = 8, encoderMode = "hardware", latencyMode = "quality", encoderRate = null, selectedRounds = null, deterministic = false,qualityInterval=2,roundFrameLimits=[] }) {
  const native = window.__native;
  const microtaskQueue=typeof process!=='undefined'&&process.env.REPLAY_MICROTASK_QUEUE==='1';
  // Fifteen queued jobs plus the awaiting continuation preserve the same
  // sixteen FIFO microtask turns, with one pending promise per checkpoint.
  const microtaskCheckpoint=()=>new Promise(resolve=>{let remaining=15;const next=()=>{if(--remaining)queueMicrotask(next);else resolve()};queueMicrotask(next)});
  // Keep simulation tickers active and render once, after their state updates.
  native.app.ticker.remove(native.app.render, native.app);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height + (window.__surfaceStream ? 8 : 0);
  const draw = canvas.getContext('2d', { alpha: false, willReadFrequently: false });
  const font = getComputedStyle(document.getElementById('data_replay')).fontFamily;
  let pending = Promise.resolve(), failure, count = 0, encodedCount = 0;
  const selection=selectedRounds===null?null:new Set(selectedRounds);
  const timelineRounds=[],warmingRounds=new Set(),warmups=new Map();let timelineRound=null,timelineStart=0;
  const base64 = bytes => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(s);
  };
  function mixEffects(audio, firstSample, lastSample, forceJS=false) {
  if(window.__nativeMixEffects&&!forceJS){
    let reference;
    if(window.__verifyNativeMix){const channels=[audio.getChannelData(0).slice(),audio.getChannelData(1).slice()];reference={sampleRate:audio.sampleRate,getChannelData:i=>channels[i]};}
    window.__nativeMixEffects(audio,firstSample,lastSample);
    if(reference){mixEffects(reference,firstSample,lastSample,true);for(let channel=0;channel<2;channel++){const expected=reference.getChannelData(channel),actual=audio.getChannelData(channel);for(let i=firstSample;i<lastSample;i++)if(expected[i]!==actual[i])throw Error(`Native audio mix differs at channel ${channel}, sample ${i}: ${actual[i]} vs ${expected[i]}`)}}
    return;
  }
  const left = audio.getChannelData(0), right = audio.getChannelData(1);
  // Mix native decoded effects directly into the rendered music buffer. Creating
  // thousands of short-lived Web Audio nodes in a single OfflineAudioContext
  // makes Chrome's graph traversal grow quadratically for long matches.
  for (const effect of window.__offlineSfx) {
    const source = effect.buffer, rate = effect.rate * source.sampleRate / audio.sampleRate;
    const eventStart = Math.max(0, Math.round(effect.time * audio.sampleRate));
    const start = Math.max(firstSample, eventStart);
    const end = Math.min(lastSample, Math.ceil((effect.time + effect.length / effect.rate) * audio.sampleRate), Math.ceil(effect.stop * audio.sampleRate));
    const src0 = source.getChannelData(0), src1 = source.numberOfChannels > 1 ? source.getChannelData(1) : src0;
    const pan = Math.max(-1, Math.min(1, effect.pan));
    const a = Math.cos((pan + 1) * Math.PI / 4), b = Math.sin((pan + 1) * Math.PI / 4);
    for (let frame = start; frame < end; frame++) {
      const pos = effect.offset * source.sampleRate + (frame - eventStart) * rate, idx = Math.floor(pos), frac = pos - idx;
      if (idx + 1 >= src0.length) break;
      const l = src0[idx] + (src0[idx + 1] - src0[idx]) * frac;
      const r = src1[idx] + (src1[idx + 1] - src1[idx]) * frac;
      if (source.numberOfChannels === 1) { left[frame] += l * effect.gain * a; right[frame] += l * effect.gain * b; }
      else if (pan <= 0) { left[frame] += effect.gain * (l + r * Math.cos((pan + 1) * Math.PI / 2)); right[frame] += effect.gain * r * Math.sin((pan + 1) * Math.PI / 2); }
      else { left[frame] += effect.gain * l * Math.cos(pan * Math.PI / 2); right[frame] += effect.gain * (r + l * Math.sin(pan * Math.PI / 2)); }
    }
  }
  }
  async function writeAudio(buffer,first,last,binding) {
    if(window.__writeNativeAudio){window.__writeNativeAudio(buffer,first,last,binding===window.__writeRoundAudio?'round':'master');return;}
    const left=buffer.getChannelData(0),right=buffer.getChannelData(1);
    for(let offset=first;offset<last;offset+=8192){
      const length=Math.min(8192,last-offset),pcm=new Float32Array(length*2);
      for(let i=0;i<length;i++){pcm[i*2]=left[offset+i];pcm[i*2+1]=right[offset+i]}
      if(window.__writeNativePCM)window.__writeNativePCM(pcm,binding===window.__writeRoundAudio?'round':'master');
      else await binding(base64(new Uint8Array(pcm.buffer)));
    }
  }
  const config = { latencyMode, codec: encoderRate > 120 ? 'avc1.640034' : 'avc1.640033', width, height, bitrate: Math.round(12000000*(encoderRate||fps)/fps), framerate: encoderRate||fps, hardwareAcceleration: encoderMode === 'software' ? 'prefer-software' : 'prefer-hardware', avc: { format: 'annexb' } };
  const audioOnly=selection?.size===0&&!!window.__installNativeAudio;
  let rawEncoder;
  if(audioOnly){window.__installNativeAudio(window.__nativeEncoderOptions);rawEncoder={finish:async()=>window.__nativeGLFlush?.()};}
  else rawEncoder=window.__createRawEncoder?.({width,height,fps});
  if(rawEncoder?.ready)await rawEncoder.ready;
  if (!rawEncoder && !(await VideoEncoder.isConfigSupported(config)).supported) throw Error('This Chrome cannot encode H.264 with WebCodecs.');
  let packets = [], packetBytes = 0;
  function flushPackets() {
    if(!packetBytes) return;
    const bytes = new Uint8Array(packetBytes);let offset=0;
    for(const packet of packets){bytes.set(packet,offset);offset+=packet.length}
    packets=[];packetBytes=0;
    const encoded=base64(bytes);
    pending=pending.then(()=>window.__writeVideo(encoded)).catch(e=>{failure=e});
  }
  const encoder = rawEncoder ? null : new VideoEncoder({
    output(chunk) {
      const bytes = new Uint8Array(chunk.byteLength);chunk.copyTo(bytes);
      packets.push(bytes);packetBytes+=bytes.length;
      if(packetBytes>=262144)flushPackets();
    },
    error(error) { failure = error; },
  });
  encoder?.configure(config);
  const timings = { simulation:0, draw:0, warmDraw:0, encode:0, queueWait:0, roundPublish:0,roundEncoderFlush:0,roundMusic:0,roundMixWrite:0,roundHostCommit:0 };
  const wallNow = window.__timeline.wallNow;
  let activeRound=null,roundStart=0,completedMasterAudio=null;
  const finalAudioReuse=typeof process!=='undefined'&&process.env.REPLAY_FINAL_AUDIO_REUSE==='1';
  const roundAudioOverlap=typeof process!=='undefined'&&process.env.REPLAY_OVERLAP_ROUND_AUDIO==='1';
  async function finishRound(partial=false,final=false,finalMusic=null){
    if(!window.__finishRound || activeRound===null)return;
    const renderMusic=()=>final&&finalAudioReuse?(finalMusic||native.audio._context.startRendering()):native.audio._context.__renderPrefix(count/fps);
    const musicPending=roundAudioOverlap?renderMusic():null;musicPending?.catch(()=>{});
    let phase=wallNow();
    if(rawEncoder?.flushRound)await rawEncoder.flushRound();
    else {await encoder.flush();flushPackets();await pending;}
    timings.roundEncoderFlush+=wallNow()-phase;phase=wallNow();
    // Once simulation ends the original graph is complete. Render it once,
    // then use its exact sample range for the final round and the master.
    const music=await (musicPending||renderMusic());
    timings.roundMusic+=wallNow()-phase;phase=wallNow();
    const first=Math.round(roundStart/fps*music.sampleRate),last=Math.round(count/fps*music.sampleRate);
    mixEffects(music,final&&finalAudioReuse?0:first,last);
    if(final&&finalAudioReuse)completedMasterAudio=music;
    await writeAudio(music,first,last,window.__writeRoundAudio);
    timings.roundMixWrite+=wallNow()-phase;phase=wallNow();
    await window.__finishRound({round:activeRound,startFrame:roundStart,endFrame:count,fps,sampleRate:music.sampleRate,partial});
    timings.roundHostCommit+=wallNow()-phase;
  }
  const maxFrames = Math.ceil((limitSeconds || maxSeconds) * fps);
  let started = false, finished = false, simulationSteps = 0;
  for (let i = 0; i < maxFrames; i++) {
    // Simulate at the game's fixed 60 Hz even when exporting a lower frame rate.
    let measuredAt = wallNow();
    const targetStep = Math.round((i + 1) * 60 / fps);
    while (simulationSteps < targetStep) {window.__replayRandom?.simulationFrame(simulationSteps); window.__timeline.step(1000 / 60); simulationSteps++; }
    if (native.games.length) started = true;
    if (started && document.getElementById('replaytools').classList.contains('hidden')) { finished = true; break; }
    // Finish native timer continuations before encoder backpressure can yield
    // to a real task. Otherwise the same countdown can draw a frame earlier
    // whenever the encoder happens to have exhausted its surface pool.
    if(deterministic){if(microtaskQueue)await microtaskCheckpoint();else for(let settle=0;settle<16;settle++)await Promise.resolve();}
    timings.simulation += wallNow()-measuredAt;measuredAt=wallNow();
    const spans = [...document.getElementById('data_replay').querySelectorAll(':scope > span')].map(el => el.textContent);
    const id=Number(spans[2]||1),shouldRender=!selection||selection.has(id);
    if(selection?.has(id+1)&&Math.max(0,...native.games.map(game=>game.getFrame()))>=roundFrameLimits[id-1]-120)warmingRounds.add(id);
    const warmPrevious=warmingRounds.has(id);
    if(id!==timelineRound){
      if(timelineRound!==null)timelineRounds.push({round:timelineRound,startFrame:timelineStart,endFrame:count});
      timelineRound=id;timelineStart=count;
      if(window.__beginRound){
        const publishStarted=wallNow();
        await finishRound();activeRound=null;
        if(shouldRender){activeRound=id;roundStart=count;await window.__beginRound({round:id,startFrame:count});rawEncoder?.beginRound?.();}
        const publishMs=wallNow()-publishStarted;timings.roundPublish+=publishMs;measuredAt+=publishMs;
      }
    }
    if(shouldRender||warmPrevious){
    if(shouldRender&&rawEncoder?.beforeFrame)await rawEncoder.beforeFrame();
    // Render and copy in this same JS task before WebGL clears its drawing buffer.
    const render=()=>window.__drawNativeGame?window.__drawNativeGame():native.app.renderer.render(native.app.stage);
    if(window.__replayRandom)window.__replayRandom.drawFrame(count,render);
    else render();
    if(!shouldRender){let record=warmups.get(id);if(!record){record={round:id,firstFrame:count,lastFrame:count,frames:0};warmups.set(id,record)}record.lastFrame=count;record.frames++;timings.warmDraw+=wallNow()-measuredAt;}
    }
    if(shouldRender){
    if(rawEncoder?.compose)rawEncoder.compose({native,spans,font,roundCount});
    else {
    draw.drawImage(native.app.view, 0, 0, width, height);
    if (native.foreground?.view.width === width) draw.drawImage(native.foreground.view, 0, 0, width, height);
    draw.fillStyle = '#080808dd';draw.fillRect(0, 0, width, height * .065);
    draw.fillStyle = '#ff8a00';draw.font = `bold ${Math.round(height * .035)}px ${font}`;
    draw.fillText('REPLAY', width * .02, height * .045);
    draw.fillStyle = 'white';draw.font = `${Math.round(height * .027)}px ${font}`;
    draw.fillText(`${spans[0] || ''} VS ${spans[1] || ''}${spans[2] ? ` · ROUND ${spans[2]} / ${roundCount}` : ''}`, width * .15, height * .043);
    }
    timings.draw += wallNow()-measuredAt;measuredAt=wallNow();
    if(window.__qualitySample && count%Math.max(1,Math.round(fps*qualityInterval))===0){
      rawEncoder?.qualitySample?.(draw,count);
      if(!rawEncoder?.qualityInputsOnly){
      const sample=document.createElement('canvas');sample.width=width;sample.height=height;
      sample.getContext('2d',{alpha:false,willReadFrequently:true}).drawImage(canvas,0,0);
      await window.__qualitySample(count,sample.toDataURL('image/png').split(',')[1]);
      }
    }
    if(rawEncoder) await rawEncoder.write(rawEncoder.capture(canvas));
    else {
    const frame = new VideoFrame(canvas, { timestamp: Math.round(count * 1000000 / fps), duration: Math.round(1000000 / fps) });
    encoder.encode(frame, { keyFrame: count === roundStart || count % (fps * 2) === 0 });frame.close();
    }
    encodedCount++;
    timings.encode += wallNow()-measuredAt;measuredAt=wallNow();
    if (encoder && encoder.encodeQueueSize > queue) await new Promise(resolve => encoder.addEventListener('dequeue', resolve, { once: true }));
    timings.queueWait += wallNow()-measuredAt;
    }
    // Awaiting the encoder normally lets native replay promises settle each
    // frame. Skipped rounds need the same microtask boundary.
    else await Promise.resolve();
    if(deterministic){if(microtaskQueue)await microtaskCheckpoint();else for(let settle=0;settle<16;settle++)await Promise.resolve();}
    count++;
    if (failure) throw failure;
    if (i % ((selection||__timeline.fastYield&&rawEncoder)?fps*10:fps) === 0) {
      await pending;
      await window.__renderProgress({ seconds: count / fps, round: spans[2], frames: native.games.map(g => g.getFrame()) });
      await window.__timeline.yield();
    }
  }
  if(timelineRound!==null)timelineRounds.push({round:timelineRound,startFrame:timelineStart,endFrame:count});
  const finalMusic=roundAudioOverlap&&finalAudioReuse&&activeRound!==null?native.audio._context.startRendering():null;finalMusic?.catch(()=>{});
  if(rawEncoder) await rawEncoder.finish();
  else { await encoder.flush();flushPackets();await pending; }
  await finishRound(!finished,true,finalMusic);
  encoder?.close();
  await window.__renderProgress({stage:'video complete'});
  if (failure) throw failure;
  if (!finished && !limitSeconds) throw Error('Native replay did not finish within the export frame limit.');
  await window.__renderProgress({stage:'audio rendering started'});
  const audio = completedMasterAudio||await native.audio._context.startRendering();
  await window.__renderProgress({stage:'audio rendering complete'});
  const samples = Math.round(count / fps * audio.sampleRate);
  if (samples > audio.length) throw Error('Offline audio buffer was too short.');
  if(!completedMasterAudio)mixEffects(audio, 0, samples);
  await writeAudio(audio,0,samples,window.__writeAudio);
  await window.__renderProgress({stage:'audio transfer complete'});
  return { rawEncoder:!!rawEncoder,audioOnly,finalAudioReuse:!!completedMasterAudio,roundAudioOverlap, timings, encoderRate, latencyMode, encoderMode, queue, count, encodedCount, timelineRounds, selectedRounds, warmups:[...warmups.values()], deterministic,simulationMicrotaskCheckpoint:deterministic?16:0,microtaskQueue,fastYield:window.__timeline.fastYield, audioPCMHash:window.__nativePCMHash?.(), audioGraph:window.__traceAudioGraph?native.audio._context.__describeGraph():undefined, duration: count / fps, sampleRate: audio.sampleRate, samples, finished };
};
