const {app,BrowserWindow}=require('electron');
const backend=process.env.REPLAY_NATIVE_ENCODER||'surface-encoder';
if(!['surface-encoder','x264-surface-encoder'].includes(backend))throw Error('Unsupported native probe encoder');
const encoder=require(`./native/${backend}.node`);
const path=require('node:path');
app.setPath('userData',require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(),'replay-electron-')));
app.commandLine.appendSwitch('use-angle','metal');
app.whenReady().then(()=>{
  const width=1920,height=1080,total=500,held=new Map();
  let submitted=0,finished=0,start,closing=false;
  const output=process.argv[2]||path.join(app.getPath('temp'),'surface-probe.h264');
  const win=new BrowserWindow({show:false,width,height,useContentSize:true,webPreferences:{offscreen:{useSharedTexture:true,sharedTexturePixelFormat:'nv12'},backgroundThrottling:false}});
  const deadline=setTimeout(()=>{console.error('Encoder probe timed out',JSON.stringify({submitted,finished}));app.exit(1)},30000);
  encoder.open(width,height,60,12000000,output,(id,status)=>{
    const texture=held.get(id);if(!texture){console.error('Unexpected encoder completion',id);app.exit(1);return}texture.release();held.delete(id);finished++;
    if(status){console.error('Encode failed',id,status);app.exit(1);return}
    if(finished===total){
      const written=encoder.close();clearTimeout(deadline);const seconds=(performance.now()-start)/1000;
      console.log('RESULT',JSON.stringify({backend,submitted,finished,written,seconds,fps:finished/seconds,output,bytes:require('node:fs').statSync(output).size}));setImmediate(()=>app.quit());
    }
  });
  win.webContents.on('paint',(event)=>{
    const texture=event.texture;if(!texture)return;
    if(submitted>=total){texture.release();return}
    try{
      const info=texture.textureInfo;
      if(submitted===0){console.log('TEXTURE',JSON.stringify({format:info.pixelFormat,size:info.codedSize}));start=performance.now()}
      const id=submitted++;held.set(id,texture);encoder.encode(info.handle.ioSurface,id,id%120===0);
      if(submitted===total){closing=true;win.webContents.stopPainting()}
    }catch(error){console.error(error.stack);texture.release();clearTimeout(deadline);app.exit(1)}
  });
  win.webContents.setFrameRate(1000);
  win.loadURL('data:text/html,'+encodeURIComponent('<html><body style="margin:0"><canvas id="c" width="1920" height="1080"></canvas><script>let n=0;const g=c.getContext("2d");function next(){g.fillStyle=`hsl(${n++%360} 90% 50%)`;g.fillRect(0,0,1920,1080);g.fillStyle="white";g.font="48px sans-serif";g.fillText(String(n),40,70);requestAnimationFrame(next)}next()</script></body></html>'));
});
app.on('window-all-closed',()=>app.quit());
