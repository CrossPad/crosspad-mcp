/* Top-bar controls: pause/resume, reset view, PNG/CSV export, force-reconnect,
   and keyboard shortcuts. */

import { state, sigs } from "./state.js";
import { curRange, renderExport } from "./plot.js";
import { downloadBlob, tstamp, toast } from "./util.js";
import { forceReconnect, getConnState, hasSocket } from "./connection.js";
import { toggleFull } from "./config.js";

let pauseBtn=null, pauseLbl=null;

/* Pause = HOLD: keep ingesting samples (no data lost) but FREEZE the view by
   pinning the current range. Resume clears the pin → back to the live window. */
export function togglePause(){
  state.paused=!state.paused;
  if(state.paused){
    const [a,b]=curRange();
    state.viewT0=a; state.viewT1=b;
  }else{
    state.viewT0=null; state.viewT1=null;
  }
  pauseBtn.classList.toggle("active",state.paused);
  if(pauseLbl) pauseLbl.textContent=state.paused?"Resume":"Pause";
}

/* Reset view: drop manual time AND Y overrides → back to the live window. */
export function resetView(){ state.viewT0=null; state.viewT1=null; state.viewY0=null; state.viewY1=null; }

/* High-contrast, labeled, 2× export (see plot.renderExport) — far more legible
   than dumping the live low-contrast canvas. */
function exportPng(){
  try{
    const fsText=document.getElementById("fs")?.textContent||"";
    const off=renderExport(fsText);
    off.toBlob(b=>{ if(b) downloadBlob("trace-"+tstamp()+".png",b); else toast("PNG export failed"); });
  }catch(_){ toast("PNG export failed"); }
}

/* Top-bar "i" help popover (replaces the canvas tooltip that blocked the view). */
function initInfo(){
  const info=document.getElementById("info");
  const help=document.getElementById("help");
  if(!info||!help)return;
  info.onclick=(e)=>{ e.stopPropagation(); help.hidden=!help.hidden; };
  document.addEventListener("click",(e)=>{
    if(!help.hidden && e.target!==info && !help.contains(e.target)) help.hidden=true;
  });
}

/* CSV: wide format over the visible window. Sample frames share one timestamp
   across all signals (PROTOCOL §10), so rows key on `t`, columns = signals. */
function exportCsv(){
  const names=[...sigs.keys()];
  if(!names.length){ toast("nothing to export","info"); return; }
  const [t0,t1]=curRange();
  const rowsByT=new Map();
  for(const n of names) for(const p of sigs.get(n).data){
    if(p.t<t0||p.t>t1)continue;
    let row=rowsByT.get(p.t); if(!row){row={};rowsByT.set(p.t,row);}
    row[n]=p.v;
  }
  if(!rowsByT.size){ toast("no samples in view","info"); return; }
  const ts=[...rowsByT.keys()].sort((a,b)=>a-b);
  const q=v=>{const s=String(v); return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;};
  let csv="t,"+names.map(q).join(",")+"\n";
  for(const t of ts){ const row=rowsByT.get(t); csv+=t+","+names.map(n=>n in row?row[n]:"").join(",")+"\n"; }
  downloadBlob("trace-"+tstamp()+".csv",new Blob([csv],{type:"text/csv"}));
}

export function initToolbar(){
  pauseBtn=document.getElementById("pause");
  pauseLbl=pauseBtn.querySelector(".lbl");
  pauseBtn.onclick=togglePause;
  document.getElementById("auto").onclick=resetView;
  document.getElementById("expPng").onclick=exportPng;
  document.getElementById("expCsv").onclick=exportCsv;
  document.getElementById("reconnect").onclick=()=>forceReconnect();
  initInfo();

  // Keyboard shortcuts — inert while typing in an input/select/textarea.
  document.addEventListener("keydown",e=>{
    if(e.key==="Escape"){ const help=document.getElementById("help"); if(help) help.hidden=true; }
    const tag=(e.target&&e.target.tagName)||"";
    if(/^(INPUT|SELECT|TEXTAREA)$/.test(tag))return;
    if(e.metaKey||e.ctrlKey||e.altKey)return;
    if(e.key===" "){ e.preventDefault(); togglePause(); }
    else if(e.key==="r"||e.key==="R"){ resetView(); }
    else if(e.key==="f"||e.key==="F"){ toggleFull(); }
  });

  // Tab backgrounded + socket died → retry as soon as it's visible again.
  document.addEventListener("visibilitychange",()=>{
    if(document.visibilityState==="visible" && !hasSocket() && getConnState()!=="connected") forceReconnect();
  });
}
