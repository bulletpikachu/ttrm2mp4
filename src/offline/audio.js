// Build the native Web Audio graph offline. Nodes are the browser's real Web
// Audio nodes; only currentTime and lifecycle calls use the export timeline.
(() => {
  const Offline = window.OfflineAudioContext;
  window.__offlineAudioContexts = [];
  window.__offlineSfx = [];
  window.AudioContext = class {
    constructor(options = {}) {
      const sampleRate = options.sampleRate || 48000;
      const context = new Offline(2, Math.ceil(window.__audioLength * sampleRate), sampleRate);
      window.__installAudioDecodeCache?.(context);
      Object.defineProperty(context, 'currentTime', { get: () => window.__timeline?.seconds || 0 });
      Object.defineProperty(context, 'state', { get: () => 'running' });
      context.resume = async () => {};
      context.suspend = async () => {};
      context.close = async () => {};
      if(window.__recordAudioGraph)window.__recordAudioGraph(context);
      window.__offlineAudioContexts.push(context);
      return context;
    }
  };
  window.webkitAudioContext = window.AudioContext;
})();
