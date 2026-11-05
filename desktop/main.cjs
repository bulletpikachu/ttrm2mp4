const {app,BrowserWindow,ipcMain,dialog,shell,nativeImage,screen}=require('electron');
const path=require('node:path'),fs=require('node:fs');
const root=path.resolve(__dirname,'..');
// Packaged Electron launches its app entry even when Playwright supplies a script.
if(process.env.REPLAY_ENGINE_ENTRY){
  const allowed=['electron-main.cjs','surface-main.cjs','surface-stream-main.cjs','prepare-main.cjs'].map(name=>path.join(root,'src/experimental',name));
  if(!allowed.includes(path.resolve(process.env.REPLAY_ENGINE_ENTRY)))throw Error('Invalid rendering engine entry');
  require(process.env.REPLAY_ENGINE_ENTRY);
}else{
  let window,queueWindow,jobs,setup,quitting=false;const files=new Map(),outputs=new Set();
  app.setName('ttrm2mp4');
  // Keep existing preferences, appearance imports, and game files after the rename.
  app.setPath('userData',process.env.REPLAY_DESKTOP_USER_DATA
    ?path.resolve(process.env.REPLAY_DESKTOP_USER_DATA)
    :path.join(app.getPath('appData'),'Replay Render'));
  const userData=app.getPath('userData');fs.mkdirSync(userData,{recursive:true});
  const preferencesPath=path.join(userData,'preferences.json');
  const appearancePath=path.join(userData,'appearance.json');
  function preferences(){
    try{
      const settings=JSON.parse(fs.readFileSync(preferencesPath,'utf8'));
      delete settings.duration;
      return settings;
    }catch{return {}}
  }
  const localClient=path.join(root,'client');
  const initialClient=!app.isPackaged&&fs.existsSync(path.join(localClient,'manifest.json'))?localClient:path.join(userData,'client');
  const indexFile=path.join(__dirname,'dist/index.html');
  const appIcon=path.join(__dirname,'assets/icon.png');

  function createArtworkWindow(title,filename,minimumWidth,workArea,show=true){
    const artwork=nativeImage.createFromPath(path.join(__dirname,'assets',filename));
    if(artwork.isEmpty())throw Error('Could not load '+filename);
    const size=artwork.getSize(),aspectRatio=size.width/size.height;
    const width=Math.min(size.width,workArea.width,Math.floor(workArea.height*aspectRatio));
    const minWidth=Math.min(width,minimumWidth);
    const view=new BrowserWindow({
      title,show,frame:false,roundedCorners:false,maximizable:false,fullscreenable:false,useContentSize:true,
      width,height:Math.round(width/aspectRatio),minWidth,minHeight:Math.round(minWidth/aspectRatio),
      icon:appIcon,
      backgroundColor:'#fff',
      webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true},
    });
    view.setAspectRatio(aspectRatio);
    const scaleInterface=()=>{
      const [contentWidth,contentHeight]=view.getContentSize();
      const factor=Math.min(contentWidth/size.width,contentHeight/size.height);
      if(factor>0)view.webContents.setZoomFactor(factor);
    };
    view.on('resize',scaleInterface);
    view.webContents.once('did-finish-load',()=>{
      view.webContents.setZoomMode('isolated');
      scaleInterface();
    });
    view.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    view.webContents.on('will-navigate',event=>event.preventDefault());
    return view;
  }

  async function start(){
    app.dock?.setIcon(appIcon);
    const {RenderJobs,inspectReplay,validateSettings}=await import('./jobs.mjs');
    const {ClientSetup,clientReady}=await import('./setup.mjs');
    const {storedAppearance,summarizeAppearance,updateAppearance,readImport}=await import('./appearance.mjs');
    let importing=false;
    const executable=app.isPackaged?process.execPath:app.getPath('exe');
    setup=new ClientSetup({root,executable,userData});
    setup.on('event',event=>{if(!window.isDestroyed())window.webContents.send('render:event',event);});
    jobs=new RenderJobs({root,executable:app.isPackaged?process.execPath:require('electron').app.getPath('exe'),userData});
    jobs.on('event',event=>{if(event.type==='finished')outputs.add(event.output);if(!window.isDestroyed())window.webContents.send('render:event',event);});
    window=createArtworkWindow('ttrm2mp4','majime.png',680,screen.getPrimaryDisplay().workArea);
    const from=(event,view)=>view&&!view.isDestroyed()&&event.sender===view.webContents&&event.senderFrame===view.webContents.mainFrame;
    const handle=(name,fn,isQueue=false)=>ipcMain.handle(name,async(event,...args)=>{
      if(!from(event,isQueue?queueWindow:window))throw Error('Invalid application frame');
      return fn(...args);
    });
    const windowControl=(name,action)=>ipcMain.handle(name,event=>{
      const view=from(event,window)?window:from(event,queueWindow)?queueWindow:null;
      if(!view)throw Error('Invalid application frame');
      action(view);
    });
    windowControl('window:minimize',view=>view.minimize());
    windowControl('window:close',view=>view.close());

    let queueState={files:[],busy:false};
    const sendQueue=()=>queueWindow?.webContents.send('queue:state',queueState);
    handle('queue:open',async()=>{
      if(queueWindow){
        if(queueWindow.isMinimized())queueWindow.restore();
        queueWindow.focus();
        return;
      }
      const bounds=window.getBounds(),{workArea}=screen.getDisplayMatching(bounds);
      const popup=createArtworkWindow('ttrm2mp4 Queue','queue.png',380,workArea,false);
      queueWindow=popup;
      popup.on('closed',()=>{queueWindow=null;});
      const [width,height]=popup.getSize();
      popup.setPosition(
        Math.max(workArea.x,Math.min(workArea.x+workArea.width-width,Math.round(bounds.x+(bounds.width-width)/2))),
        Math.max(workArea.y,Math.min(workArea.y+workArea.height-height,Math.round(bounds.y+(bounds.height-height)/2))),
      );
      try{
        await popup.loadFile(indexFile,{query:{view:'queue'}});
        if(!popup.isDestroyed())popup.show();
      }
      catch(error){if(!popup.isDestroyed()){popup.destroy();throw error;}}
    });
    handle('queue:update',state=>{queueState=state;sendQueue();});
    handle('queue:ready',sendQueue,true);
    handle('queue:edit',id=>{
      if(queueState.busy||jobs.active||setup.active)return;
      if(id!==null&&!queueState.files.some(file=>file.id===id))throw Error('Unknown replay');
      window.webContents.send('queue:edit',id);
    },true);
    handle('render:initial',async()=>{const settings={outputDirectory:app.getPath('videos'),clientDirectory:initialClient,backend:'auto',width:1920,height:1080,fps:60,...preferences()};return {settings,platform:process.platform,clientReady:await clientReady(settings.clientDirectory),appearance:summarizeAppearance(await storedAppearance(appearancePath))};});
    handle('render:add',async paths=>{
      if(!Array.isArray(paths)||paths.length>100)throw Error('Choose up to 100 replay files');
      const added=[];
      for(const file of paths){const replay=await inspectReplay(file);files.set(replay.id,replay);added.push(replay);}return added;
    });
    handle('render:folder',async kind=>{
      if(!['output','client'].includes(kind))throw Error('Invalid folder picker');
      const result=await dialog.showOpenDialog(window,{title:kind==='client'?'Choose prepared game files':'Choose export folder',properties:['openDirectory',...(kind==='output'?['createDirectory']:[])]});
      if(result.canceled)return null;
      const selected=result.filePaths[0];
      if(kind==='client'){
        const manifest=JSON.parse(fs.readFileSync(path.join(selected,'manifest.json'),'utf8'));
        if(manifest.format!==1||!manifest.entries)throw Error('Choose a prepared client folder containing manifest.json');
      }return selected;
    });
    handle('render:import-appearance',async()=>{
      if(jobs.active||setup.active||importing)throw Error('Wait for the current task to finish');
      importing=true;
      try{
        const result=await dialog.showOpenDialog(window,{title:'Import TETR.IO appearance',properties:['openFile'],filters:[{name:'TETR.IO settings and packs',extensions:['ttc','tpse']}]});
        if(result.canceled)return null;
        return await updateAppearance(appearancePath,await readImport(result.filePaths[0],nativeImage));
      }finally{importing=false;}
    });
    handle('render:clear-appearance',async()=>{
      if(jobs.active||setup.active||importing)throw Error('Wait for the current task to finish');
      importing=true;
      try{return await updateAppearance(appearancePath,null);}
      finally{importing=false;}
    });
    handle('render:prepare',async id=>{
      if(jobs.active||setup.active||importing)throw Error('Wait for the current task to finish');
      if(!files.has(id))throw Error('Add a replay file before setting up TETR.IO files');
      const directory=await setup.start(files.get(id).path);
      fs.writeFileSync(preferencesPath,JSON.stringify({...preferences(),clientDirectory:directory},null,2));
      return directory;
    });
    handle('render:client-ready',directory=>clientReady(directory));
    handle('render:start',(ids,raw)=>{
      if(setup.active||importing)throw Error('Wait for the current task to finish');
      const settings=validateSettings(raw);
      if(!Array.isArray(ids)||ids.some(id=>!files.has(id)))throw Error('Choose replay files first');
      const jobId=jobs.start(ids.map(id=>files.get(id)),settings,fs.existsSync(appearancePath)?appearancePath:undefined);
      fs.writeFileSync(preferencesPath,JSON.stringify(settings,null,2));return jobId;
    });
    const cancelActive=()=>setup.active?setup.cancel():jobs.cancel();
    handle('render:cancel',cancelActive);
    handle('queue:reveal',file=>{if(!outputs.has(file))throw Error('Choose a completed export');shell.showItemInFolder(file);},true);
    window.on('close',event=>{if((jobs.active||setup.active)&&!quitting){event.preventDefault();cancelActive().finally(()=>{quitting=true;window.close()});}});
    window.on('closed',()=>queueWindow?.destroy());
    await window.loadFile(indexFile);
  }
  app.whenReady().then(start).catch(error=>{console.error('DESKTOP STARTUP:',error.stack);dialog.showErrorBox('Could not start ttrm2mp4',error.message);app.quit();});
  app.on('window-all-closed',()=>app.quit());
  app.on('before-quit',event=>{if((jobs?.active||setup?.active)&&!quitting){event.preventDefault();(setup.active?setup.cancel():jobs.cancel()).finally(()=>{quitting=true;app.quit()});}});
}
