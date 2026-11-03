window.__surfaceStream=true;
window.__createRawEncoder=({width,height,fps})=>{
  const {ipcRenderer}=require('electron');
  const creditLimit=Number(process.env.REPLAY_SURFACE_CREDITS||3);
  if(!Number.isInteger(creditLimit)||creditLimit<1||creditLimit>16)throw Error('Invalid surface credit limit');
  const metrics={creditWaitMs:0,rafWaitMs:0,creditLimit};
  let attached=false,index=0,inflight=0,failure=null,waiters=[];
  ipcRenderer.on('surface-stream-credit',()=>{inflight--;const next=waiters.shift();if(next)next.resolve()});
  ipcRenderer.on('surface-stream-error',(_event,message)=>{failure=Error(message);for(const w of waiters)w.reject(failure);waiters=[]});
  const ready=ipcRenderer.invoke('surface-stream-open');
  return {
    ready,
    async beforeFrame(){await ready;if(failure)throw failure;let t=window.__timeline.wallNow();if(inflight>=creditLimit)await new Promise((resolve,reject)=>waiters.push({resolve,reject}));metrics.creditWaitMs+=window.__timeline.wallNow()-t;if(failure)throw failure;t=window.__timeline.wallNow();await window.__timeline.nextCompositorFrame();metrics.rafWaitMs+=window.__timeline.wallNow()-t},
    capture:canvas=>canvas,
    async write(canvas){
      if(failure)throw failure;
      if(!attached){
        canvas.id='export-surface';canvas.style.cssText=`position:fixed;left:0;top:0;width:${width}px;height:${height+8}px;z-index:2147483647;pointer-events:none;visibility:visible;opacity:1;transform:none;`;
        const style=document.createElement('style');style.textContent='body > :not(#export-surface){visibility:hidden!important}';document.head.appendChild(style);document.body.appendChild(canvas);attached=true;
      }
      const draw=canvas.getContext('2d');draw.fillStyle='black';draw.fillRect(0,height,width,8);
      for(let bit=0;bit<48;bit++){
        const on=bit<16?((0xA55A>>>bit)&1):((index>>>(bit-16))&1);
        draw.fillStyle=on?'white':'black';draw.fillRect(bit*4,height,4,8);
      }
      index++;inflight++;
    },
    async finish(){if(failure)throw failure;window.__surfaceResult={...(await ipcRenderer.invoke('surface-stream-close',index)),metrics}},
  };
};
