const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const config=JSON.parse(process.env.REPLAY_SURFACE_CONFIG||'{}');
if(!['hardware','cpu'].includes(config.encoder))throw Error('Invalid native surface encoder');
const planes=config.qualitySamples?require('./native/surface-planes.node'):null;
const reference=config.reference?require('./native/surface-encoder.node'):null;
if(reference&&config.encoder!=='cpu')throw Error('Reference encode requires the CPU test backend');
const encoder=require(`./native/${config.encoder==='cpu'?'x264-surface-encoder':'surface-encoder'}.node`);
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'replay-surface-')));
app.commandLine.appendSwitch('use-angle','metal');app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
let win,pending=null,opened=false,expected=0,failure=null,held=new Map(),paintCount=0,bitmapOnly=0;
app.whenReady().then(()=>{
  win=new BrowserWindow({show:false,width:config.width,height:config.height,useContentSize:true,webPreferences:{nodeIntegration:true,contextIsolation:false,sandbox:false,backgroundThrottling:false,offscreen:{useSharedTexture:true,sharedTexturePixelFormat:'nv12',deviceScaleFactor:1}}});
  win.webContents.setFrameRate(1000);
  win.webContents.on('did-finish-load',()=>win.webContents.setFrameRate(1000));
  win.webContents.on('paint',event=>{
    paintCount++;const texture=event.texture;if(!texture){bitmapOnly++;return}
    if(!pending){texture.release();return}
    const request=pending;pending=null;clearTimeout(request.timer);
    try{
      const info=texture.textureInfo;
      if(info.widgetType!=='frame'||info.codedSize.width!==config.width||info.codedSize.height!==config.height)throw Error('Unexpected compositor surface');
      if(planes && request.index%(config.fps*2)===0){
        fs.mkdirSync(config.qualitySamples,{recursive:true});
        const frame=planes.lock(info.handle.ioSurface);
        try{
          if(frame[0].stride!==config.width||frame[1].stride!==config.width)throw Error('Padded sample surface is unsupported');
          const target=path.join(config.qualitySamples,`frame-${String(request.index).padStart(6,'0')}.nv12`);
          const fd=fs.openSync(target,config.overwrite?'w':'wx');try{for(const plane of frame)fs.writeSync(fd,plane.data)}finally{fs.closeSync(fd)}
        }finally{planes.unlock(info.handle.ioSurface)}
      }
      held.set(request.index,{texture,remaining:reference?2:1});encoder.encode(info.handle.ioSurface,request.index,request.key);
      if(reference)reference.encode(info.handle.ioSurface,request.index,request.key);
      expected++;request.resolve({index:request.index,format:info.pixelFormat,frameRate:win.webContents.getFrameRate(),colorSpace:info.colorSpace});
    }catch(error){held.delete(request.index);texture.release();failure=error;request.reject(error)}
  });
  ipcMain.handle('surface-open',()=>{
    if(opened)throw Error('Surface encoder already open');
    win.webContents.setFrameRate(1000);
    const completed=(id,status)=>{
      const entry=held.get(id);if(entry){entry.remaining--;if(!entry.remaining){entry.texture.release();held.delete(id)}}else failure=Error('Unexpected native encoder completion');
      if(status)failure=Error(`Native encoder failed (${status})`);
    };
    encoder.open(config.width,config.height,config.fps,12000000,config.output,completed);
    if(reference)reference.open(config.width,config.height,config.fps,12000000,config.reference,completed);
    opened=true;return true;
  });
  ipcMain.handle('surface-frame',(_event,index,key)=>{
    if(failure)throw failure;if(!opened||pending||index!==expected)throw Error('Surface frame sequence mismatch');
    return new Promise((resolve,reject)=>{
      pending={index,key:!!key,resolve,reject,timer:setTimeout(()=>{pending=null;failure=Error(`No compositor frame within 10 seconds (index=${index}, paints=${paintCount}, bitmapOnly=${bitmapOnly}, held=${held.size})`);reject(failure)},10000)};
      win.webContents.invalidate();
    });
  });
  ipcMain.handle('surface-close',async()=>{
    if(failure)throw failure;if(!opened||pending)throw Error('Encoder not ready to close');
    const written=encoder.close();if(reference){const count=reference.close();if(count!==written)throw Error('Reference frame count mismatch')}opened=false;
    while(held.size)await new Promise(resolve=>setImmediate(resolve));
    if(failure)throw failure;if(written!==expected)throw Error(`Encoded ${written} frames; expected ${expected}`);
    return {written,encoder:config.encoder,codecSettings:config.encoder==='cpu'?{preset:'ultrafast',crf:18,threads:Number(process.env.REPLAY_X264_THREADS||4)}:{bitrate:12000000}};
  });
  win.loadURL('about:blank');
});
app.on('window-all-closed',()=>app.quit());
