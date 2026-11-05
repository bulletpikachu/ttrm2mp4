import {useEffect,useState} from 'react';
import type {QueueState} from './types';
import {WindowControls} from './WindowControls';

const duration=(seconds:number)=>`${Math.floor(seconds/60)}:${String(Math.floor(seconds%60)).padStart(2,'0')}`;

export function Queue(){
  const [state,setState]=useState<QueueState>({files:[],busy:false});
  const [error,setError]=useState('');
  const {files,busy}=state;
  useEffect(()=>{
    const unsubscribe=window.replayRender.onQueue(setState);
    void window.replayRender.queueReady().catch(error=>setError(error.message));
    return unsubscribe;
  },[]);

  async function edit(id:string|null){
    setError('');
    try{await window.replayRender.editQueue(id);}
    catch(error){setError((error as Error).message);}
  }

  return <main className="queue-window">
    <header className="titlebar"><WindowControls/></header>
    <section className="sketchbook" aria-label="Replay queue">
      {files.length>0?<ul className="file-list" tabIndex={0} aria-label="Queued replays">
        {files.map(file=><li className="file-row" key={file.id}>
          <div className="file-info">
            <strong title={file.path}>{file.name}</strong>
            <small>{duration(file.duration)} · {file.status||'Queued'}</small>
          </div>
          {file.status==='Complete'&&file.output&&<button className="text" title="Show video" aria-label={'Show video for '+file.name} onClick={()=>void window.replayRender.reveal(file.output!).catch(error=>setError(error.message))}>↗</button>}
          {!busy&&<button className="remove" title="Remove replay" aria-label={'Remove '+file.name} onClick={()=>void edit(file.id)}>×</button>}
        </li>)}
      </ul>:<p className="help">Queue is empty.</p>}
      {error&&<p role="alert" className="queue-error">{error}</p>}
      {files.length>0&&<button className="text clear-queue" disabled={busy} onClick={()=>void edit(null)}>Clear queue</button>}
    </section>
  </main>;
}
