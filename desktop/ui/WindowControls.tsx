export function WindowControls(){
  return <div className="window-controls" role="group" aria-label="Window controls">
    <button className="window-button" aria-label="Minimize window" title="Minimize" onClick={()=>void window.replayRender.minimizeWindow()}>
      <img src="../assets/minimize.png" alt="" draggable={false}/>
    </button>
    <button className="window-button close-window" aria-label="Close window" title="Close" onClick={()=>void window.replayRender.closeWindow()}>
      <img src="../assets/close.png" alt="" draggable={false}/>
    </button>
  </div>;
}
