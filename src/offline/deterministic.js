// Separate simulation randomness from drawing randomness. A worker may skip a
// draw without changing later effect/sound random choices in the native game.
(() => {
  function random(seed){return()=>{let value=seed+=0x6D2B79F5;value=Math.imul(value^(value>>>15),value|1);value^=value+Math.imul(value^(value>>>7),value|61);return((value^(value>>>14))>>>0)/4294967296}}
  Math.random=random(0x2B09A731);
  window.__replayRandom={
    simulationFrame(frame){Math.random=random((0x2B09A731^Math.imul(frame+1,0x9E3779B1))>>>0)},
    drawFrame(frame,draw){const previous=Math.random;Math.random=random((0x6A42D3E5^Math.imul(frame+1,0x9E3779B1))>>>0);try{return draw()}finally{Math.random=previous}},
  };
})();
