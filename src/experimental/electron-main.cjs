const {app,BrowserWindow,powerSaveBlocker}=require('electron');
global.__replayInstallLocalClient=async config=>{
  if(process.platform!=='win32'||process.env.REPLAY_WINDOWS_NATIVE_CLIENT!=='1')throw Error('Native client transport is Windows-only and must be explicitly enabled');
  if(global.__replayLocalClientStore)throw Error('Local client transport already installed');
  const {installElectronClient}=await import('../offline/electron-client.mjs');
  global.__replayLocalClientStore=await installElectronClient(require('electron').session.defaultSession,config);
  return global.__replayLocalClientStore.manifest;
};
global.__replayLocalClientMissing=()=>[...global.__replayLocalClientStore.missing];
app.setPath('userData',require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(),'replay-electron-')));
if(process.platform==='darwin')app.commandLine.appendSwitch('use-angle','metal');
if(process.env.REPLAY_CHROMIUM_SOFTWARE==='1')app.commandLine.appendSwitch('disable-gpu');
if(process.env.REPLAY_V8_FLAGS)app.commandLine.appendSwitch('js-flags',process.env.REPLAY_V8_FLAGS);
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
powerSaveBlocker.start('prevent-app-suspension');
app.whenReady().then(()=>{global.renderWindow=new BrowserWindow({show:false,width:1920,height:1080,useContentSize:true,webPreferences:{nodeIntegration:true,contextIsolation:false,sandbox:false,backgroundThrottling:false}});renderWindow.loadURL('about:blank')});
let closingWindows=false;
if(process.platform==='win32')app.on('before-quit',()=>{
  // The offline export has already flushed its media. The game's interactive
  // beforeunload prompt must not keep hidden export windows alive on shutdown.
  closingWindows=true;
  for(const window of BrowserWindow.getAllWindows())window.destroy();
});
app.on('window-all-closed',()=>{if(!closingWindows)app.quit()});
