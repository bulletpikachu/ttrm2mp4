const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const config=JSON.parse(process.env.REPLAY_SURFACE_CONFIG||'{}');
if(config.encoder!=='cpu')throw Error('Streaming experiment currently requires native x264');
const encoder=require('./native/x264-surface-encoder.node'),planes=require('./native/surface-planes.node');
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'replay-stream-')));
app.commandLine.appendSwitch('use-angle','metal');app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
let win,opened=false,captured=0,duplicates=0,unmarked=0,failure=null,closing=null,total=null;
const held=new Map();
function fail(error){failure=error;win.webContents.send('surface-stream-error',error.message);if(closing){closing.reject(error);closing=null}}
function finalize(){
  if(closing&&total===captured&&!held.size){
    const request=closing;closing=null;
    try{const written=encoder.close();opened=false;if(written!==total)throw Error(`Encoded ${written} frames, expected ${total}`);request.resolve({written,captured,duplicates,unmarked,ordered:true,encoder:'native-x264',codecSettings:{preset:'ultrafast',crf:18,threads:Number(process.env.REPLAY_X264_THREADS||4)}})}catch(error){fail(error);request.reject(error)}
  }
}
app.whenReady().then(()=>{
  win=new BrowserWindow({show:false,width:config.width,height:config.height+8,useContentSize:true,webPreferences:{nodeIntegration:true,contextIsolation:false,sandbox:false,backgroundThrottling:false,offscreen:{useSharedTexture:true,sharedTexturePixelFormat:'nv12',deviceScaleFactor:1}}});
  win.webContents.setFrameRate(1000);win.webContents.on('did-finish-load',()=>win.webContents.setFrameRate(1000));
  win.webContents.on('paint',event=>{
    const texture=event.texture;if(!texture)return;if(!opened||failure){texture.release();return}
    try{
      const info=texture.textureInfo;
      if(info.codedSize.width!==config.width||info.codedSize.height!==config.height+8)throw Error('Unexpected surface size');
      const marker=planes.marker(info.handle.ioSurface,config.height+2);
      if(!marker.valid){unmarked++;texture.release();return}
      if(marker.index<captured){duplicates++;texture.release();return}
      if(marker.index!==captured)throw Error(`Dropped compositor frame: expected ${captured}, received ${marker.index}`);
      held.set(marker.index,texture);encoder.encode(info.handle.ioSurface,marker.index,marker.index%(config.fps*2)===0);captured++;
    }catch(error){texture.release();fail(error)}
  });
  ipcMain.handle('surface-stream-open',()=>{
    if(opened)throw Error('Encoder already open');win.webContents.setFrameRate(1000);
    encoder.open(config.width,config.height,config.fps,12000000,config.output,(id,status)=>{
      const texture=held.get(id);if(!texture){fail(Error('Unexpected encoder completion'));return}
      texture.release();held.delete(id);if(status){fail(Error('Native x264 failed: '+status));return}
      win.webContents.send('surface-stream-credit',id);finalize();
    });opened=true;return true;
  });
  ipcMain.handle('surface-stream-close',(_event,count)=>{
    if(failure)throw failure;if(!opened||closing||!Number.isInteger(count)||count<captured)throw Error('Invalid stream finalization');
    total=count;return new Promise((resolve,reject)=>{closing={resolve,reject};finalize()});
  });
  win.loadURL('about:blank');
});
app.on('window-all-closed',()=>app.quit());
