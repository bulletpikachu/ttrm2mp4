const {app,BrowserWindow}=require('electron');
const native=require('./native/texture-probe.node');
app.setPath('userData',require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(),'replay-electron-')));
app.commandLine.appendSwitch('use-angle','metal');
app.whenReady().then(()=>{
  const win=new BrowserWindow({show:false,width:1920,height:1080,useContentSize:true,webPreferences:{offscreen:{useSharedTexture:true,sharedTexturePixelFormat:'nv12'},backgroundThrottling:false}});
  let frames=0,start;
  const deadline=setTimeout(()=>{console.error('No complete texture probe within 20 seconds');app.exit(1)},20000);
  win.webContents.on('paint',(event)=>{
    const texture=event.texture;
    if(!texture)return;
    try{
      if(frames===0){const info=texture.textureInfo;console.log('TEXTURE',JSON.stringify({format:info.pixelFormat,size:info.codedSize,native:native.inspect(info.handle.ioSurface)}));start=performance.now()}
      frames++;
      if(frames===500){clearTimeout(deadline);const seconds=(performance.now()-start)/1000;console.log('RESULT',JSON.stringify({frames,seconds,fps:frames/seconds}));setImmediate(()=>app.quit())}
    }catch(error){console.error(error.stack);clearTimeout(deadline);app.exit(1)}finally{texture.release()}
  });
  win.webContents.setFrameRate(1000);
  win.loadURL('data:text/html,'+encodeURIComponent('<html><body style="margin:0"><canvas id="c" width="1920" height="1080"></canvas><script>let n=0;const g=c.getContext("2d");function next(){g.fillStyle=`hsl(${n++%360} 90% 50%)`;g.fillRect(0,0,1920,1080);requestAnimationFrame(next)}next()</script></body></html>'));
});
app.on('window-all-closed',()=>app.quit());
