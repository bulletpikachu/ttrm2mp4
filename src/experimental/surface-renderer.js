window.__createRawEncoder=({width,height,fps})=>{
  const {ipcRenderer}=require('electron');
  let index=0,attached=false,lastCapture;
  const stopCompositor=window.__timeline.keepCompositorActive();
  const ready=ipcRenderer.invoke('surface-open');
  return {
    ready,
    capture:canvas=>canvas,
    async write(canvas){
      await ready;
      if(!attached){
        canvas.style.cssText=`position:fixed;left:0;top:0;width:${width}px;height:${height}px;z-index:2147483647;pointer-events:none;visibility:visible;opacity:1;transform:none;`;
        canvas.id='export-surface';document.body.appendChild(canvas);attached=true;
      }
      lastCapture=await ipcRenderer.invoke('surface-frame',index,index%(fps*2)===0);index++;
    },
    async finish(){window.__surfaceResult={...(await ipcRenderer.invoke('surface-close')),lastCapture};stopCompositor()},
  };
};
