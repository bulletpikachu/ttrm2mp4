import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {Settings,Replay,RenderEvent,Appearance} from './types';
import {Queue} from './Queue';
import {WindowControls} from './WindowControls';
import './style.css';
function App(){
  const [settings,setSettings]=useState<Settings>({outputDirectory:'',clientDirectory:'',backend:'auto',width:1920,height:1080,fps:60});
  const [files,setFiles]=useState<Replay[]>([]),[busy,setBusy]=useState(false),[drag,setDrag]=useState(false),[error,setError]=useState(''),[stage,setStage]=useState('Ready when you are'),[backend,setBackend]=useState('Automatic'),[progress,setProgress]=useState(0),[logs,setLogs]=useState(''),[cancelling,setCancelling]=useState(false);
  const [ready,setReady]=useState(false),[preparing,setPreparing]=useState(false);
  const [appearance,setAppearance]=useState<Appearance>({videoCount:0,assetCount:0});
  const [importing,setImporting]=useState(false);
  const hasAppearance=!!(appearance.ttc||appearance.tpse);
  const cancelRequested=useRef(false);
  const input=useRef<HTMLInputElement>(null);
  const logView=useRef<HTMLPreElement>(null);
  const followLogs=useRef(true);
  useLayoutEffect(()=>{
    const view=logView.current;
    if(view&&followLogs.current)view.scrollTop=view.scrollHeight;
  },[logs]);
  useEffect(()=>{
    void window.replayRender.updateQueue({files,busy}).catch(error=>setError(error.message));
  },[files,busy]);
  useEffect(()=>window.replayRender.onQueueEdit(id=>{
    if(!busy)setFiles(current=>id===null?[]:current.filter(file=>file.id!==id));
  }),[busy]);
  useEffect(()=>{window.replayRender.initial().then(value=>{setSettings(value.settings);setReady(value.clientReady);setAppearance(value.appearance);}).catch(error=>setError(error.message));return window.replayRender.onEvent((event:RenderEvent)=>{
    if(event.type==='setup-progress'){setStage(event.stage||'Setting up TETR.IO files');setProgress(event.progress||0);return;}
    if(event.type==='setup-completed'){setReady(true);setSettings(value=>({...value,clientDirectory:event.directory!}));setStage('TETR.IO files are ready');setProgress(1);return;}
    if(event.type==='setup-error'){setError(event.message||'Game-file setup failed');setStage('Setup failed');return;}
    if(event.type==='setup-cancelled'){setStage('Setup cancelled');return;}
    if(event.type==='setup-log'||event.type==='log'){setLogs(value=>value+(event.message||''));return;}
    if(event.type==='backend')setBackend(({mac:'Apple Silicon',portable:'Compatible renderer','windows-nvidia':'NVIDIA native'} as Record<string,string>)[event.backend||'']||'Automatic');
    if(event.type==='stage')setStage(event.stage||'Preparing export');
    if(event.type==='started'){setProgress(0);setStage('Preparing export');setFiles(value=>value.map(file=>file.id===event.fileId?{...file,status:'Rendering',output:event.output}:file));}
    if(event.type==='progress'){
      if(event.stage)setStage(event.stage);
      else{setStage(`Rendering round ${event.round||1} of ${event.roundCount||1}`);setProgress(value=>Math.max(value,Math.min(.98,(event.seconds||0)/(event.totalSeconds||1))));}
    }
    if(event.type==='finished'){setProgress(1);setFiles(value=>value.map(file=>file.id===event.fileId?{...file,status:'Complete',output:event.output}:file));setStage('Export complete');}
    if(event.type==='error'){setError(event.message||'Export failed');setStage('Export stopped');setFiles(value=>value.map(file=>file.status==='Rendering'?{...file,status:'Failed'}:file));}
    if(event.type==='cancelled'){setStage('Export cancelled');setFiles(value=>value.map(file=>file.status==='Rendering'?{...file,status:'Cancelled'}:file));}
    if(event.type==='done')setStage('All exports complete');
    if(event.type==='idle'){setBusy(false);setCancelling(false);}
  });},[]);
  async function add(incoming:File[]){
    if(busy||!incoming.length)return;
    setError('');
    try{
      const added=await window.replayRender.addFiles(incoming);
      setFiles(value=>[...value,...added.filter(file=>!value.some(old=>old.path===file.path))]);
    }catch(error){setError((error as Error).message);}
  }
  async function folder(kind:'client'|'output'){try{const selected=await window.replayRender.chooseFolder(kind);if(selected){setSettings(value=>({...value,[kind==='client'?'clientDirectory':'outputDirectory']:selected}));if(kind==='client')setReady(await window.replayRender.clientReady(selected));}}catch(error){setError((error as Error).message);}}
  async function prepareFiles(){
    setPreparing(true);setStage('Starting TETR.IO setup');setProgress(0);
    try{
      const directory=await window.replayRender.prepare(files[0].id);
      setSettings(value=>({...value,clientDirectory:directory}));setReady(true);return directory;
    }finally{setPreparing(false);}
  }
  async function setupOnly(){
    followLogs.current=true;
    setError('');setLogs('');setBusy(true);cancelRequested.current=false;
    try{await prepareFiles();}catch(error){if(!cancelRequested.current)setError((error as Error).message);}
    finally{setBusy(false);setCancelling(false);}
  }
  async function render(){
    followLogs.current=true;
    setError('');setLogs('');setProgress(0);setBusy(true);cancelRequested.current=false;
    try{
      let directory=settings.clientDirectory;
      if(!await window.replayRender.clientReady(directory))directory=await prepareFiles();
      if(cancelRequested.current){setBusy(false);return;}
      await window.replayRender.start(files.filter(file=>file.status!=='Complete').map(file=>file.id),{...settings,clientDirectory:directory});
    }catch(error){setBusy(false);setCancelling(false);if(!cancelRequested.current)setError((error as Error).message);}
  }
  async function cancel(){cancelRequested.current=true;setCancelling(true);setStage(preparing?'Stopping setup…':'Stopping export…');try{await window.replayRender.cancel();}catch(error){setError((error as Error).message);setCancelling(false);}}
  async function changeAppearance(clear=false){
    setError('');
    setImporting(true);
    try{
      const profile=clear?await window.replayRender.clearAppearance():await window.replayRender.importAppearance();
      if(profile)setAppearance(profile);
    }catch(error){setError((error as Error).message);}
    finally{setImporting(false);}
  }
  const waiting=files.filter(file=>file.status!=='Complete').length;
  return <main className={'dropzone'+(drag?' dragging':'')}
    onDragOver={event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();event.dataTransfer.dropEffect=busy?'none':'copy';setDrag(!busy);}}}
    onDragLeave={event=>{if(!(event.relatedTarget instanceof Node)||!event.currentTarget.contains(event.relatedTarget))setDrag(false);}}
    onDrop={event=>{event.preventDefault();setDrag(false);void add(Array.from(event.dataTransfer.files));}}>
    <header className="titlebar">
      <h1>ttrm<span>2</span>mp4</h1>
      <WindowControls/>
    </header>
    <div className="workspace">
      <section className="logs" aria-label="Render logs">
        <pre ref={logView} tabIndex={logs?0:undefined} aria-label="Export activity" onScroll={event=>{
          const view=event.currentTarget;
          followLogs.current=view.scrollHeight-view.clientHeight-view.scrollTop<=4;
        }}>{logs}</pre>
      </section>
      <aside className="settings" aria-label="Export settings"><fieldset disabled={busy||importing}>
      <div className="format-fields">
      <label>Resolution<select aria-label="Resolution" value={`${settings.width}x${settings.height}`} onChange={event=>{const [width,height]=event.target.value.split('x').map(Number);setSettings(value=>({...value,width,height}));}}><option value="1920x1080">1080p</option><option value="1280x720">720p</option><option value="3840x2160">4K</option></select></label>
      <label>Frame rate<select aria-label="Frame rate" value={settings.fps} onChange={event=>setSettings(value=>({...value,fps:Number(event.target.value)}))}><option value={60}>60 fps</option><option value={30}>30 fps</option></select></label>
      </div>
      <label>Rendering backend<select aria-label="Rendering backend" value={settings.backend} onChange={event=>setSettings(value=>({...value,backend:event.target.value}))}><option value="auto">Automatic</option><option value="portable">Compatible browser</option><option value="mac">Apple Silicon native</option><option value="windows-nvidia">Windows NVIDIA native</option></select></label>
      <label>Save videos to<div className="folder"><input aria-label="Output folder" title={settings.outputDirectory} value={settings.outputDirectory} onChange={event=>setSettings(value=>({...value,outputDirectory:event.target.value}))}/><button aria-label="Choose output folder" onClick={()=>void folder('output')}>Browse</button></div></label>
      <label>TETR.IO game files<div className="folder"><input aria-label="Game files folder" title={settings.clientDirectory} value={settings.clientDirectory} onChange={event=>{setSettings(value=>({...value,clientDirectory:event.target.value}));setReady(false);}}/><button aria-label="Choose game files folder" onClick={()=>void folder('client')}>Browse</button></div></label>
      <button className="secondary setup-refresh" disabled={busy||!files.length} onClick={()=>void setupOnly()}>{ready?'Download fresh game files':'Set up TETR.IO files'}</button>
      <div className="appearance-controls">
        <button className="secondary" title="Import TETR.IO .ttc settings or TETR.IO PLUS .tpse packs" onClick={()=>void changeAppearance()}>Import appearance</button>
        {hasAppearance&&<button className="text" aria-label="Clear appearance" title="Clear appearance" onClick={()=>void changeAppearance(true)}>Clear</button>}
        {appearance.ttc&&<p className="appearance-file">{appearance.ttc.name} · {appearance.videoCount} video settings</p>}
        {appearance.tpse&&<p className="appearance-file">{appearance.tpse.name} · {appearance.assetCount} assets</p>}
        {[...(appearance.ttc?.warnings||[]),...(appearance.tpse?.warnings||[])].map((warning,index)=><p className="appearance-warning" key={index}>{warning}</p>)}
      </div>
    </fieldset></aside>
    {drag&&<div className="drop-indicator" aria-hidden="true">Drop to add replays</div>}
    </div>
    {error&&<p role="alert" className="error">{error}</p>}
    <footer className="toolbar">
      <div className="replay-actions">
        <button className="secondary" disabled={busy} onClick={()=>input.current?.click()}>Choose replay files</button>
        <button className="secondary" onClick={()=>void window.replayRender.openQueue().catch(error=>setError(error.message))}>Queue <span className="count">{files.length}</span></button>
        <input ref={input} type="file" multiple accept=".ttrm" aria-label="Replay files" hidden onChange={event=>{void add(Array.from(event.target.files||[]));event.target.value='';}}/>
      </div>
      <div className="activity" aria-live="polite">
        <div className="status-line"><strong>{stage==='Ready when you are'?(ready?'':'Set up TETR.IO files once'):stage}</strong><span>{backend}</span></div>
        <progress aria-label="Export progress" value={progress} max="1"/>
      </div>
      <div className="export-actions">
        {busy?<button className="cancel" disabled={cancelling} onClick={()=>void cancel()}>{cancelling?'Stopping…':preparing?'Cancel setup':'Cancel'}</button>:<button className="primary" disabled={importing||!waiting||!settings.outputDirectory} onClick={()=>void render()}>{ready?'Render':'Set up & render'} <span aria-hidden="true">→</span></button>}
      </div>
    </footer>
  </main>;
}
const queueView=new URLSearchParams(location.search).get('view')==='queue';
if(queueView)document.title='ttrm2mp4 Queue';
createRoot(document.getElementById('root')!).render(queueView?<Queue/>:<App/>);
