// Drop-in encoder interface. Shared surfaces return to the renderer only after
// the central codec consumes them; a separate worker waits for GPU completion.
window.__createCentralEncoder=options=>{
  const net=require('node:net'),native=require(options.directory+'/central-encoder.node');
  const socket=net.createConnection(process.env.REPLAY_CENTRAL_ENCODER);socket.setNoDelay(true);
  let input='',failure=null,notify=null,submitted=0,exported=0,consumed=0,finishRequested=false,finishing=null,exporterStarted=false,session=null;
  const ready=[];
  const frames=new Map(),active=new Set(),metrics={encodeMs:0,shared:true};
  const send=message=>{if(failure)throw failure;socket.write(JSON.stringify(message)+'\n')};
  function failed(error){if(failure)return;failure=error;finishing?.reject(error);finishing=null;for(const index of active)notify?.(index,-1);active.clear();socket.destroy();}
  socket.on('error',failed);socket.on('close',()=>{if(notify)failed(Error('Shared encoder disconnected'))});
  socket.on('data',chunk=>{try{input+=chunk;if(input.length>1048576)throw Error('Shared encoder response exceeds 1 MiB');for(let at;(at=input.indexOf('\n'))>=0;){const message=JSON.parse(input.slice(0,at));input=input.slice(at+1);
    if(message.type==='opened'){session=message.session;sendReady()}
    else if(message.type==='frame'){if(!active.delete(message.index))throw Error('Unknown shared encoder completion');consumed++;notify(message.index,0)}
    else if(message.type==='closed'){if(!finishing||message.frames!==submitted||consumed!==submitted)throw Error('Shared encoder frame count mismatch');metrics.encodeMs=message.encodeMs;const done=finishing;finishing=null;notify=null;done.resolve(message.frames)}
    else throw Error('Unknown shared encoder response');
  }}catch(error){failed(error)}});
  function maybeClose(){if(finishRequested&&exported===submitted)send({type:'close',frames:submitted});}
  function sendReady(){if(session===null)return;for(const index of ready){const frame=frames.get(index);if(!frame)throw Error('Unknown shared GPU frame');native.sendFrame(index,session,frame.key);frames.delete(index);exported++;}ready.length=0;maybeClose();}
  return{
    shared:true,
    get failure(){return failure},
    open(width,height,fps,bitrate,output,callback){
      if(failure)throw failure;if(notify)throw Error('Shared encoder already open');
      notify=callback;submitted=exported=consumed=0;finishRequested=false;metrics.encodeMs=0;session=null;
      if(!exporterStarted){native.startExporter(process.env.REPLAY_CENTRAL_MACH,(kind,index,surface,status)=>{try{if(status)throw Error('Shared GPU export failed '+status);ready.push(index);sendReady()}catch(error){failed(error)}});exporterStarted=true;}
      send({type:'open',width,height,fps,output});
    },
    encode(surface,index,key,fence){if(failure)throw failure;if(finishRequested)throw Error('Shared encoder is closing');if(active.has(index))throw Error('Duplicate shared frame');frames.set(index,{key});active.add(index);submitted++;native.exportFrame(surface,index,fence)},
    stats(){return{...metrics,mainQos:native.qos()}},
    close(){if(failure)throw failure;finishRequested=true;return new Promise((resolve,reject)=>{finishing={resolve,reject};maybeClose()})},
    shutdown(){if(exporterStarted){native.stopExporter();exporterStarted=false;}socket.end();},
  };
};
