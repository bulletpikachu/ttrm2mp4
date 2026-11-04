// Probe real encoding as well as advertised support before advancing replay time.
window.__selectVideoEncoder = async function (base, mode) {
  const attempts = [];
  if (mode !== 'ffmpeg' && typeof VideoEncoder !== 'undefined') {
    const preferences = mode === 'auto' ? ['prefer-hardware', 'prefer-software', 'no-preference'] :
      [mode === 'hardware' ? 'prefer-hardware' : 'prefer-software'];
    const codecs = [...new Set([base.codec, 'avc1.4d0033', 'avc1.420033',
      ...(base.width <= 1920 && base.height <= 1080 && base.framerate <= 60 ? ['avc1.64002a', 'avc1.4d002a', 'avc1.42002a'] : [])])];
    for (const hardwareAcceleration of preferences) for (const codec of codecs) {
      const config = { ...base, codec, hardwareAcceleration };
      let probe;
      try {
        if (!(await VideoEncoder.isConfigSupported(config)).supported) { attempts.push({ codec, hardwareAcceleration, error: 'unsupported' }); continue; }
        let failure, chunks = 0;
        probe = new VideoEncoder({ output: () => chunks++, error: error => { failure = error; } });
        probe.configure(config);
        const canvas = document.createElement('canvas'); canvas.width = base.width; canvas.height = base.height;
        canvas.getContext('2d').fillRect(0, 0, canvas.width, canvas.height);
        const frame = new VideoFrame(canvas, { timestamp: 0 });
        try { probe.encode(frame, { keyFrame: true }); } finally { frame.close(); }
        await probe.flush();
        if (failure) throw failure;
        if (!chunks) throw Error('Encoder produced no test packet');
        return { backend: 'webcodecs', config, attempts };
      } catch (error) { attempts.push({ codec, hardwareAcceleration, error: error.message }); }
      finally { if (probe && probe.state !== 'closed') probe.close(); }
    }
  }
  if (mode === 'hardware') throw Error('No usable browser H.264 hardware configuration. Retry with --encoder auto or --encoder ffmpeg.');
  return { backend: 'ffmpeg', config: null, attempts };
};

window.__createFFmpegEncoder = function ({ width, height, fps }) {
  let running = false;
  const start = async () => {
    if (running) return;
    await window.__startFFmpegVideo({ width, height, fps }); running = true;
  };
  const finish = async () => {
    if (!running) return;
    await window.__finishFFmpegVideo(); running = false;
  };
  return {
    ready: start(), beginRound: start, flushRound: finish, finish,
    capture: canvas => canvas.getContext('2d').getImageData(0, 0, width, height),
    async write(image) {
      const bytes = new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength);
      let text = '';
      for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
      await window.__writeRawVideo(btoa(text));
    },
  };
};
