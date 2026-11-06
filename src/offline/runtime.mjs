import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
export const resourceRoot=process.env.REPLAY_RESOURCE_ROOT||fileURLToPath(new URL('../../',import.meta.url));
export function resourcePath(...parts){return path.join(resourceRoot,...parts);}
export function userDataDirectory(){
  if(process.env.REPLAY_USER_DATA)return process.env.REPLAY_USER_DATA;
  const base=process.platform==='win32'?(process.env.LOCALAPPDATA||path.join(homedir(),'AppData','Local')):process.platform==='darwin'?path.join(homedir(),'Library','Application Support'):(process.env.XDG_DATA_HOME||path.join(homedir(),'.local','share'));
  return path.join(base,'Replay Render');
}
export const defaultClientDirectory=process.env.REPLAY_CLIENT_DIRECTORY||resourcePath('client');
export const audioCacheDirectory=path.join(userDataDirectory(),'cache','decoded-audio');
export async function electronExecutable(){
  return process.env.REPLAY_ELECTRON_EXECUTABLE||(await import('electron')).default;
}
export function engineEnvironment(entry,env=process.env){
  const result={...env,REPLAY_ENGINE_ENTRY:entry};delete result.ELECTRON_RUN_AS_NODE;return result;
}
export function emitRenderEvent(type,data={}){
  if(process.env.REPLAY_EVENTS==='1'&&process.connected)process.send({type:'render-event',event:{type,...data}});
}
export function forwardRenderEvents(child,extra={}){
  child.on('message',message=>{if(message?.type==='render-event'&&process.connected)process.send({...message,event:{...message.event,...extra}});});
}
// Preserve app/runtime location and IPC settings when dropping native tuning.
export function portableEnvironment(env=process.env){
  const retained=new Set(['REPLAY_RESOURCE_ROOT','REPLAY_USER_DATA','REPLAY_CLIENT_DIRECTORY','REPLAY_ELECTRON_EXECUTABLE','REPLAY_EVENTS','REPLAY_DESKTOP','REPLAY_LEFT_PLAYER']);
  return Object.fromEntries(Object.entries(env).filter(([key])=>!key.startsWith('REPLAY_')||retained.has(key)));
}
