// Record the native music graph so a completed prefix can be rendered without
// consuming the original OfflineAudioContext. This preserves loop phase and
// automation across separately published round files.
window.__recordAudioGraph = context => {
  const Offline = window.OfflineAudioContext, nodes = [], connections = [];
  const destination = context.destination;
  function parameter(param) {
    const events = [], descriptor = Object.getOwnPropertyDescriptor(AudioParam.prototype, 'value');
    const initial = param.value;
    Object.defineProperty(param, 'value', {
      get: () => descriptor.get.call(param),
      set: value => { events.push(['setValueAtTime', [value, context.currentTime]]); descriptor.set.call(param, value); },
    });
    for (const name of ['setValueAtTime','linearRampToValueAtTime','exponentialRampToValueAtTime','setTargetAtTime','setValueCurveAtTime','cancelScheduledValues','cancelAndHoldAtTime']) {
      if (typeof param[name] !== 'function') continue;
      const original = param[name].bind(param);
      param[name] = (...args) => { events.push([name, args.map(a => a instanceof Float32Array ? a.slice() : a)]); return original(...args); };
    }
    return {initial,events};
  }
  for (const [method, params] of Object.entries({createGain:['gain'],createBiquadFilter:['frequency','detune','Q','gain'],createStereoPanner:['pan'],createBufferSource:['playbackRate','detune']})) {
    const original = context[method].bind(context);
    context[method] = (...args) => {
      const node = original(...args), record = {method,node,params:{},starts:[],stops:[]};
      for (const key of params) record.params[key] = parameter(node[key]);
      const connect = node.connect.bind(node);
      node.connect = (to, ...ports) => { connections.push({from:node,to,ports}); return connect(to,...ports); };
      node.disconnect = (...args) => { throw Error('Dynamic music-graph disconnection is not supported for round-prefix rendering'); };
      if (method === 'createBufferSource') {
        const start=node.start.bind(node), stop=node.stop.bind(node);
        node.start=(...args)=>{record.starts.push(args);return start(...args)};
        node.stop=(...args)=>{record.stops.push(args);return stop(...args)};
      }
      nodes.push(record);return node;
    };
  }
  context.__renderPrefix = async endSeconds => {
    const clone = new Offline(2, Math.max(1,Math.round(endSeconds*context.sampleRate)), context.sampleRate);
    const map = new Map([[destination, clone.destination]]);
    for(const record of nodes){
      const node=clone[record.method]();map.set(record.node,node);
      if(record.method==='createBiquadFilter')node.type=record.node.type;
      if(record.method==='createBufferSource')for(const key of ['buffer','loop','loopStart','loopEnd'])node[key]=record.node[key];
      for(const [key,param]of Object.entries(record.params)){
        node[key].value=param.initial;
        for(const [method,args]of param.events)node[key][method](...args);
      }
    }
    for(const {from,to,ports}of connections){if(!map.has(to))throw Error('Unsupported native music graph connection');map.get(from).connect(map.get(to),...ports)}
    for(const record of nodes)if(record.method==='createBufferSource'){
      const node=map.get(record.node);
      for(const args of record.starts)node.start(...args);
      for(const args of record.stops)node.stop(...args);
    }
    return clone.startRendering();
  };
  context.__describeGraph=()=>nodes.map(({method,params,starts,stops,node})=>({method,params,starts,stops,bufferLength:node.buffer?.length,loop:node.loop}));
};
