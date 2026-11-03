// Installed before the game. Real browser time is used for loading; after freeze,
// every timer and animation callback runs against the exporter-controlled clock.
(() => {
  const native = { raf: requestAnimationFrame.bind(window), caf: cancelAnimationFrame.bind(window), timeout: setTimeout.bind(window), clear: clearTimeout.bind(window), now: performance.now.bind(performance), date: Date.now.bind(Date) };
  const immediate=typeof require==='function'&&process.env.REPLAY_FAST_YIELD==='1'?require('node:timers').setImmediate:null;
  let active = false, time = 0, origin = 0, wallOrigin = 0, sequence = 0;
  const timers = new Map(), frames = new Map();
  const now = () => active ? time : native.now();
  performance.now = now;
  Date.now = () => active ? wallOrigin + time - origin : native.date();
  function schedule(callback, delay, args, interval) {
    const id = ++sequence;
    const item = { callback, args, interval, delay: Math.max(interval ? 1 : 0, Number(delay) || 0), due: now() + Math.max(0, Number(delay) || 0) };
    timers.set(id, item);
    const fire = () => {
      if (!timers.has(id) || active) return;
      if (!interval) timers.delete(id);
      if (typeof callback === 'function') callback(...args); else (0, eval)(String(callback));
      if (interval && timers.has(id)) { item.due = now() + item.delay; item.native = native.timeout(fire, item.delay); }
    };
    if (!active) item.native = native.timeout(fire, item.delay);
    return id;
  }
  window.setTimeout = (cb, ms, ...args) => schedule(cb, ms, args, false);
  window.setInterval = (cb, ms, ...args) => schedule(cb, ms, args, true);
  window.clearTimeout = window.clearInterval = id => { const t = timers.get(id); if (t) native.clear(t.native); timers.delete(id); };
  window.requestAnimationFrame = callback => {
    const id = ++sequence, item = { callback };
    frames.set(id, item);
    if (!active) item.native = native.raf(t => { if (active || !frames.has(id)) return; frames.delete(id); callback(t); });
    return id;
  };
  window.cancelAnimationFrame = id => { const f = frames.get(id); if (f) native.caf(f.native); frames.delete(id); };
  window.__timeline = {
    fastYield:!!immediate,
    get seconds() { return active ? (time - origin) / 1000 : 0; },
    get time() { return time; },
    restartOrigin(){if(!active)throw Error('Clock is not frozen');origin=time;wallOrigin=1700000000000},
    wallNow: native.now,
    nextCompositorFrame: () => new Promise(resolve => native.raf(resolve)),
    keepCompositorActive() { let running=true; const tick=()=>{if(running)native.raf(tick)};native.raf(tick);return ()=>{running=false}; },
    freeze({deterministic=false}={}) {
      if (active) throw Error('Clock already frozen');
      time = origin = native.now(); wallOrigin = native.date(); active = true;
      if(deterministic){const shift=65536-origin;time=origin=65536;wallOrigin=1700000000000;for(const timer of timers.values())timer.due+=shift;}
      for (const t of timers.values()) native.clear(t.native);
      for (const f of frames.values()) native.caf(f.native);
    },
    step(ms) {
      if (!active) throw Error('Clock is not frozen');
      const target = time + ms;
      let count = 0;
      while (true) {
        let id, next;
        for (const [key, t] of timers) if (t.due <= target && (!next || t.due < next.due)) { id = key; next = t; }
        if (!next) break;
        if (++count > 10000) throw Error('Runaway virtual timer');
        time = Math.max(time, next.due);
        if (next.interval) next.due = time + next.delay; else timers.delete(id);
        if (typeof next.callback === 'function') next.callback(...next.args); else (0, eval)(String(next.callback));
      }
      time = target;
      const batch = [...frames]; frames.clear();
      for (const [, frame] of batch) frame.callback(time);
    },
    yield: () => new Promise(resolve => immediate?immediate(resolve):native.timeout(resolve, 0)),
  };
})();
