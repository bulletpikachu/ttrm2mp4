// GPU snapshots transfer to workers; synchronous GPU reads then stall a worker,
// allowing the original game renderer to advance the next frame concurrently.
window.__createNV12Workers=(width,height,{slots})=>{
  const count=Number(process.env.REPLAY_PBO_WORKERS||3);
  if(!Number.isInteger(count)||count<1||count>8)throw Error('REPLAY_PBO_WORKERS must be 1–8');
  const pending=[],free=Array.from({length:slots},(_,id)=>({id,bytes:new Uint8Array(width*height*3/2),ready:false,error:null,meta:null}));
  const all=new Map(free.map(slot=>[slot.id,slot]));let cursor=0,checked=false,referencePack;
  const source=`self.window=self;self.__createNV12Packer=${window.__createNV12Packer.toString()};
    const pack=__createNV12Packer(${width},${height});
    self.onmessage=({data:{bitmap,buffer,id}})=>{try{
      const bytes=new Uint8Array(buffer);pack(bitmap,bytes);bitmap.close();
      self.postMessage({id,buffer},[buffer]);
    }catch(error){bitmap?.close();self.postMessage({id,error:error.stack||String(error)})}};`;
  const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
  const workers=Array.from({length:count},()=>{
    const worker=new Worker(url);
    worker.onmessage=({data})=>{
      const slot=all.get(data.id);if(!slot)return;
      if(data.error){slot.error=Error(data.error);return;}
      slot.bytes=new Uint8Array(data.buffer);
      if(slot.reference){
        const reference=slot.reference;slot.reference=null;
        for(let i=0;i<reference.length;i++)if(slot.bytes[i]!==reference[i]){slot.error=Error('Worker GPU copy changed packed byte '+i+': '+slot.bytes[i]+' vs '+reference[i]);return;}
      }
      slot.ready=true;
    };
    worker.onerror=error=>{for(const slot of pending)slot.error=Error('GPU copy worker failed: '+error.message)};
    return worker;
  });
  return {
    get freeCount(){return free.length},get pendingCount(){return pending.length},peek:()=>pending[0],
    submit(canvas,meta){
      const slot=free.pop();if(!slot)throw Error('GPU worker ring is full');slot.meta=meta;slot.ready=false;slot.error=null;pending.push(slot);
      if(!checked){referencePack=__createNV12Packer(width,height);slot.reference=referencePack(canvas).data.slice();checked=true;}
      const worker=workers[cursor++%workers.length];
      createImageBitmap(canvas,{premultiplyAlpha:'none',colorSpaceConversion:'none'}).then(bitmap=>{
        const buffer=slot.bytes.buffer;slot.bytes=null;worker.postMessage({bitmap,buffer,id:slot.id},[bitmap,buffer]);
      }).catch(error=>slot.error=error);
      return slot;
    },
    ready(slot){if(slot.error)throw slot.error;return slot.ready},
    read(slot){if(slot!==pending[0]||!slot.ready)throw Error('Worker readbacks must remain ordered');return slot.bytes},
    release(slot){if(pending.shift()!==slot)throw Error('Worker slot released out of order');slot.meta=null;free.push(slot)},
    close(){if(pending.length)throw Error('Cannot close pending worker readbacks');for(const worker of workers)worker.terminate();URL.revokeObjectURL(url);referencePack=null;},
  };
};
