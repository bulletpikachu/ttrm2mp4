// Diagnostic only: measure native scene traversal with one board side omitted.
// Global effects and the full 1920x1080 layout remain active. This is not a
// complete export and must never be used as a quality/speed success result.
window.__drawNativeGame = () => {
  const {app}=window.__native,scene=app.stage.children.find(child=>child.name==='gScene');
  const boards=scene?.children.find(child=>child.name==='gSceneFG');
  if(!boards)throw Error('Pinned native board scene was not found');
  const side=window.__renderBoardSide,changed=[];
  try{
    for(const child of boards.children){
      const left=child.x<innerWidth/2;
      if((side==='left'?!left:left)&&child.visible){changed.push(child);child.visible=false;}
    }
    app.renderer.render(app.stage);
  }finally{for(const child of changed)child.visible=true}
};
