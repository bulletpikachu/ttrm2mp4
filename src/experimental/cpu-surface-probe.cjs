const {app,BrowserWindow}=require('electron');
const native=require('./native/surface-planes.node');
const {spawn}=require('node:child_process');const path=require('node:path');
app.setPath('userData',require('node:fs').mkdtempSync(path.join(require('node:os').tmpdir(),'replay-electron-')));
app.commandLine.appendSwitch('use-angle','metal');
app.whenReady().then(()=>{
  const width=1920,height=1080,total=500;let submitted=0,finished=0,inflight=0,start,copied;
  const output=process.argv[2]||path.join(app.getPath('temp'),'surface-cpu.h264');
  const encoder=spawn(path.resolve('node_modules/ffmpeg-static/ffmpeg'),['-hide_banner','-loglevel','error','-nostdin','-y','-f','rawvideo','-pixel_format','nv12','-video_size',`${width}x${height}`,'-framerate','60','-i','pipe:0','-an','-c:v','libx264','-preset','ultrafast','-crf','18','-threads',process.env.REPLAY_X264_THREADS||'0','-pix_fmt','nv12','-f','h264',output],{stdio:['pipe','ignore','pipe']});
  let stderr='';encoder.stderr.on('data',b=>{stderr+=b});encoder.on('error',e=>{console.error(e);app.exit(1)});encoder.stdin.on('error',e=>{console.error(e,stderr);app.exit(1)});
  encoder.on('exit',code=>{if(code){console.error(stderr);app.exit(1);return}clearTimeout(deadline);const seconds=(performance.now()-start)/1000;console.log('RESULT',JSON.stringify({submitted,finished,seconds,fps:finished/seconds,externalBufferCopied:copied,output,bytes:require('node:fs').statSync(output).size}));app.quit()});
  const win=new BrowserWindow({show:false,width,height,useContentSize:true,webPreferences:{offscreen:{useSharedTexture:true,sharedTexturePixelFormat:'nv12'},backgroundThrottling:false}});
  const deadline=setTimeout(()=>{console.error('CPU surface probe timed out',{submitted,finished,inflight});encoder.kill();app.exit(1)},30000);
  win.webContents.on('paint',event=>{
    const texture=event.texture;if(!texture)return;
    if(submitted>=total||inflight>=4){texture.release();return}
    let locked=false;
    try{
      const handle=texture.textureInfo.handle.ioSurface,planes=native.lock(handle);locked=true;copied=planes.some(p=>p.copied);
      if(planes[0].stride!==width||planes[0].height!==height||planes[1].stride!==width||planes[1].height!==height/2)throw Error('Unexpected padded surface');
      if(!submitted)start=performance.now();submitted++;inflight++;
      encoder.stdin.cork();encoder.stdin.write(planes[0].data);encoder.stdin.write(planes[1].data,()=>{native.unlock(handle);texture.release();finished++;inflight--;if(finished===total)encoder.stdin.end()});encoder.stdin.uncork();
      if(submitted===total)win.webContents.stopPainting();
    }catch(e){if(locked)native.unlock(texture.textureInfo.handle.ioSurface);texture.release();console.error(e.stack);encoder.kill();app.exit(1)}
  });
  win.webContents.setFrameRate(1000);
  win.loadURL('data:text/html,'+encodeURIComponent('<html><body style="margin:0"><canvas id="c" width="1920" height="1080"></canvas><script>let n=0;const g=c.getContext("2d");function next(){g.fillStyle=`hsl(${n++%360} 90% 50%)`;g.fillRect(0,0,1920,1080);g.fillStyle="white";g.font="48px sans-serif";g.fillText(String(n),40,70);requestAnimationFrame(next)}next()</script></body></html>'));
});
app.on('window-all-closed',()=>app.quit());
