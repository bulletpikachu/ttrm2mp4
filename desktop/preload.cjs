const {contextBridge,ipcRenderer,webUtils}=require('electron');
const subscribe=(channel,callback)=>{
  const listener=(_event,value)=>callback(value);
  ipcRenderer.on(channel,listener);
  return ()=>ipcRenderer.removeListener(channel,listener);
};
contextBridge.exposeInMainWorld('replayRender',{
  minimizeWindow:()=>ipcRenderer.invoke('window:minimize'),
  closeWindow:()=>ipcRenderer.invoke('window:close'),
  initial:()=>ipcRenderer.invoke('render:initial'),
  addFiles:files=>ipcRenderer.invoke('render:add',Array.from(files,file=>webUtils.getPathForFile(file))),
  chooseFolder:kind=>ipcRenderer.invoke('render:folder',kind),
  importAppearance:()=>ipcRenderer.invoke('render:import-appearance'),
  clearAppearance:()=>ipcRenderer.invoke('render:clear-appearance'),
  prepare:id=>ipcRenderer.invoke('render:prepare',id),
  clientReady:directory=>ipcRenderer.invoke('render:client-ready',directory),
  start:(ids,settings)=>ipcRenderer.invoke('render:start',ids,settings),
  cancel:()=>ipcRenderer.invoke('render:cancel'),
  openQueue:()=>ipcRenderer.invoke('queue:open'),
  updateQueue:state=>ipcRenderer.invoke('queue:update',state),
  queueReady:()=>ipcRenderer.invoke('queue:ready'),
  editQueue:id=>ipcRenderer.invoke('queue:edit',id),
  reveal:file=>ipcRenderer.invoke('queue:reveal',file),
  onQueue:callback=>subscribe('queue:state',callback),
  onQueueEdit:callback=>subscribe('queue:edit',callback),
  onEvent:callback=>subscribe('render:event',callback),
});
