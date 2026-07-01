/* Config panel wiring (client-side only). Mirrors the side-panel controls into
   the shared cfg object. toggleFull is exported for the keyboard shortcut. */

import { sigs, cfg } from "./state.js";

let cfgWindow, cfgFull, cfgMax, cfgYMode;

function applyFull(){
  cfg.full=cfgFull.checked;
  cfgWindow.disabled=cfg.full;   // trailing window is meaningless in full-history
}

export function toggleFull(){
  if(!cfgFull)return;
  cfgFull.checked=!cfgFull.checked;
  applyFull();
}

/* Reflect a new visible window width (e.g. from wheel-zoom) into cfg + the input
   so the "Trailing window" field never goes stale while zooming. */
export function setWindow(sec){
  if(!(sec>0))return;
  cfg.windowSec=sec;
  if(cfgWindow) cfgWindow.value = sec<10 ? sec.toFixed(1) : String(Math.round(sec));
}

export function initConfig(){
  cfgWindow=document.getElementById("cfgWindow");
  cfgFull=document.getElementById("cfgFull");
  cfgMax=document.getElementById("cfgMax");
  cfgYMode=document.getElementById("cfgYMode");

  cfgWindow.onchange=()=>{ const v=parseFloat(cfgWindow.value); if(v>0) cfg.windowSec=v; };
  cfgFull.onchange=applyFull;
  cfgMax.onchange=()=>{
    const v=parseInt(cfgMax.value,10);
    if(v>=100){ cfg.maxSamples=v; for(const[,s]of sigs) while(s.data.length>v) s.data.shift(); }
  };
  cfgYMode.onchange=()=>{ cfg.yMode=cfgYMode.value; };
}
