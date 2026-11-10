import {useEffect,useRef,useState} from 'react';
import type {QueueState,Replay} from './types';
import {WindowControls} from './WindowControls';

const duration=(seconds:number)=>`${Math.floor(seconds/60)}:${String(Math.floor(seconds%60)).padStart(2,'0')}`;

function RoundPicker({file,locked,onError}:{file:Replay;locked:boolean;onError:(message:string)=>void}){
  const popover=useRef<HTMLDivElement>(null);
  const [selection,setSelection]=useState<Set<number>>(()=>new Set());
  const [saving,setSaving]=useState(false);
  const id='round-picker-'+file.id;
  const all=Array.from({length:file.rounds},(_,index)=>index+1);

  async function save(){
    setSaving(true);
    onError('');
    try{
      await window.replayRender.setRounds(file.id,[...selection]);
      popover.current?.hidePopover();
    }catch(error){onError((error as Error).message);}
    finally{setSaving(false);}
  }

  return <>
    <button type="button" className="text rounds-toggle" popoverTarget={id} aria-label={'Rounds for '+file.name}
      onClick={()=>setSelection(new Set(file.selectedRounds??all))}>
      {file.selectedRounds?`${file.selectedRounds.length} of ${file.rounds}`:'All rounds'} <span aria-hidden="true">▾</span>
    </button>
    <div ref={popover} id={id} className="round-picker" popover="auto">
      <fieldset disabled={locked||saving}>
        <legend>Rounds to render</legend>
        <div className="round-picker-actions">
          <button className="text" onClick={()=>setSelection(new Set(all))}>Select all</button>
          <button className="text" onClick={()=>setSelection(new Set())}>Clear</button>
        </div>
        <div className="round-options">
          {all.map(round=><label key={round}>
            <input type="checkbox" checked={selection.has(round)} onChange={event=>{
              const next=new Set(selection);
              if(event.target.checked)next.add(round);
              else next.delete(round);
              setSelection(next);
            }}/>
            Round {round}
          </label>)}
        </div>
        <button className="secondary" disabled={!selection.size} onClick={()=>void save()}>Apply</button>
      </fieldset>
    </div>
  </>;
}

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

  async function setLeftPlayer(id:string,playerId:string){
    setError('');
    try{await window.replayRender.setLeftPlayer(id,playerId);}
    catch(error){setError((error as Error).message);}
  }

  return <main className="queue-window">
    <header className="titlebar"><WindowControls/></header>
    <section className="sketchbook" aria-label="Replay queue">
      {files.length>0?<ul className="file-list" tabIndex={0} aria-label="Queued replays">
        {files.map(file=>{
          const players=file.players;
          const left=players?.find(player=>player.id===file.leftPlayer)??players?.[0];
          const right=players?.find(player=>player.id!==left?.id);
          const locked=busy||file.status==='Complete';
          const playerOrderId='player-order-'+file.id;
          return <li className="file-row" key={file.id}>
            <div className="file-info">
              <div className="file-heading">
                <strong title={file.path}>{file.name}</strong>
                {left&&right&&<button type="button" className="text player-order-toggle" popoverTarget={playerOrderId}
                  aria-label={'Players for '+file.name}>Players <span aria-hidden="true">▾</span></button>}
              </div>
              <div className="file-meta">
                <small>{duration(file.duration)} · {file.status||'Queued'}</small>
                {!file.singleplayer&&<RoundPicker file={file} locked={locked} onError={setError}/>}
              </div>
            </div>
            {file.status==='Complete'&&file.output&&<button className="text" title="Show video" aria-label={'Show video for '+file.name} onClick={()=>void window.replayRender.reveal(file.output!).catch(error=>setError(error.message))}>↗</button>}
            {!busy&&<button className="remove" title="Remove replay" aria-label={'Remove '+file.name} onClick={()=>void edit(file.id)}>×</button>}
            {left&&right&&<div id={playerOrderId} className="player-order" popover="auto">
              <span className="player-order-name" title={left.username}>Left <strong>{left.username}</strong></span>
              <button className="secondary" aria-label={'Swap players for '+file.name} disabled={locked}
                onClick={()=>void setLeftPlayer(file.id,right.id)}>Swap</button>
            </div>}
          </li>;
        })}
      </ul>:<p className="help">Queue is empty.</p>}
      {error&&<p role="alert" className="queue-error">{error}</p>}
      {files.length>0&&<button className="text clear-queue" disabled={busy} onClick={()=>void edit(null)}>Clear queue</button>}
    </section>
  </main>;
}
