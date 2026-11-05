// Downloads run in a fresh, sandboxed browser window without Node access.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'replay-prepare-browser-'));
app.setPath('userData',profile);
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.whenReady().then(()=>{
  const window=new BrowserWindow({show:false,width:1280,height:720,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.loadURL('about:blank');
});
app.on('window-all-closed',()=>app.quit());
app.on('will-quit',()=>{try{fs.rmSync(profile,{recursive:true,force:true})}catch{}});
app.on('before-quit',()=>{for(const window of BrowserWindow.getAllWindows())window.destroy();});
