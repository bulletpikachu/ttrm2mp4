// Trusted, offline Electron renderer only. Keep media bytes out of browser IPC.
(() => {
  const fs = require('node:fs'), { createHash } = require('node:crypto');
  const settings = window.__directIOOptions, masterHash = createHash('sha256');
  let roundOpen = false;
  window.__beginDirectRound = () => { roundOpen = true; };
  window.__endDirectRound = () => { roundOpen = false; };
  window.__writeEncodedVideo = bytes => {
    const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    fs.appendFileSync(settings.video, data);
    if (roundOpen) fs.appendFileSync(settings.roundVideo, data);
  };
  window.__nativePCMHash = () => masterHash.digest('hex');
  window.__writeNativeAudio = (audio, first, last, kind) => {
    const left = audio.getChannelData(0), right = audio.getChannelData(1);
    for (let offset = first; offset < last; offset += 262144) {
      const length = Math.min(262144, last - offset), bytes = Buffer.allocUnsafe(length * 8);
      const pcm = new Float32Array(bytes.buffer, bytes.byteOffset, length * 2);
      for (let i = 0; i < length; i++) { pcm[i * 2] = left[offset + i]; pcm[i * 2 + 1] = right[offset + i]; }
      fs.appendFileSync(kind === 'round' ? settings.roundAudio : settings.audio, bytes);
      if (kind === 'master') masterHash.update(bytes);
    }
  };
})();
