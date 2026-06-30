/* WebSocket link + connection/trace state machine + inbound frame dispatch +
   outbound commands (PROTOCOL §12.5).

   The Node UI server is a PERSISTENT singleton: it stays up across trace
   start/stop and only the bound session comes and goes. So we treat the socket
   and the trace as two INDEPENDENT lifecycles:

   connState  — the WebSocket link: "connected" / "reconnecting" / "disconnected".
   traceState — whether a trace is producing samples: "active" / "idle" / "ended".

   The connection dot reflects connState; the banner reflects traceState. The
   reconnect loop uses exponential backoff and retries forever; a successful open
   resets it. The manual Reconnect button reuses the same loop. */

import { state, sigs, fsState, fsNoteSample } from "./state.js";
import { toast } from "./util.js";
import { reconcile, push, toDesc } from "./signals.js";
import { loadSymbols } from "./symbols.js";

let ws=null;
let connState="reconnecting";   // flips to "connected" on open
let traceState="idle";          // until hello.active/trace_start says otherwise
let reconnectTimer=null;
let reconnectDelay=0;
let manualClose=false;
const RECONNECT_MIN=500;
const RECONNECT_MAX=5000;

export function getConnState(){ return connState; }
export function hasSocket(){ return !!ws; }

/* Open a fresh socket. Never throws; failure falls through to onclose →
   scheduleReconnect, so the loop is self-healing. */
export function connect(){
  if(reconnectTimer){clearTimeout(reconnectTimer);reconnectTimer=null;}
  let sock;
  try{ sock=new WebSocket("ws://"+location.host); }
  catch(_){ scheduleReconnect(); return; }
  ws=sock;
  sock.onopen=()=>{
    if(ws!==sock)return;
    reconnectDelay=0;
    setConn("connected");
    setBanner("syncing","sync");   // real trace state arrives via the fresh hello
    loadSymbols();                 // refresh autocomplete on every (re)connect
  };
  sock.onclose=()=>{
    if(ws!==sock)return;
    ws=null;
    if(manualClose){manualClose=false;}
    scheduleReconnect();
  };
  sock.onerror=()=>{};
  sock.onmessage=(e)=>{ try{ handleFrame(e.data); }catch(_){} };
}

function scheduleReconnect(){
  setConn("reconnecting");
  if(reconnectTimer)return;
  reconnectDelay=reconnectDelay?Math.min(reconnectDelay*2,RECONNECT_MAX):RECONNECT_MIN;
  reconnectTimer=setTimeout(()=>{reconnectTimer=null;connect();},reconnectDelay);
}

/* Drop the current socket and retry now at the minimum delay. */
export function forceReconnect(){
  reconnectDelay=0;
  if(reconnectTimer){clearTimeout(reconnectTimer);reconnectTimer=null;}
  const old=ws; ws=null;
  if(old){
    manualClose=true;
    try{old.onopen=old.onclose=old.onerror=old.onmessage=null;}catch(_){}
    try{old.close();}catch(_){}
  }
  setConn("reconnecting");
  connect();
}

/* Parse + dispatch one inbound frame. Defensive: tolerates junk/unknown/missing;
   never throws. Note: samples are ALWAYS ingested — pause only freezes the view
   (see toolbar.togglePause), so no data is lost across a pause. */
function handleFrame(data){
  let m; try{m=JSON.parse(data);}catch(_){return;}
  if(!m||typeof m!=="object")return;
  switch(m.type){
    case "hello":
      if(Array.isArray(m.signals)) reconcile(m.signals.map(toDesc), null);
      setTrace(m.active?"active":"idle");
      break;
    case "trace_start":
      resetPlot();
      if(Array.isArray(m.signals)) reconcile(m.signals.map(toDesc), null);
      setTrace("active");
      break;
    case "trace_end":
      setTrace("ended");
      break;
    case "signals":
      if(Array.isArray(m.signals)) reconcile(m.signals, m.unresolved);
      break;
    case "sample":
      if(m.values && typeof m.values==="object"){
        if(traceState!=="active") setTrace("active");
        const t=typeof m.t==="number"?m.t:performance.now()/1000;
        fsNoteSample(t);
        for(const k in m.values){const v=m.values[k]; if(typeof v==="number") push(k,t,v);}
      }
      break;
    case "status":
      setStat("device: "+(m.device_state||"?"));
      {const f=(typeof m.actual_fs==="number")?m.actual_fs:(typeof m.fs==="number"?m.fs:null);
       if(f!=null&&isFinite(f)&&f>0) fsState.reported=f;}
      break;
    case "error":
      toast("error: "+(m.error||"unknown"));
      break;
    default: break;
  }
}

/* ---------- presentation of the two state machines ---------- */
function setStat(s){const el=document.getElementById("stat"); if(el)el.textContent=s;}

export function setConn(stateName){
  connState=stateName;
  const dot=document.getElementById("connDot");
  const txt=document.getElementById("connTxt");
  if(!dot||!txt)return;
  dot.className="cdot";
  if(stateName==="connected"){
    dot.classList.add(traceState==="active"?"ok":"idle");
    dot.textContent="●"; txt.textContent="connected";
  }else if(stateName==="reconnecting"){
    dot.classList.add("retry"); dot.textContent="○"; txt.textContent="reconnecting…";
  }else{
    dot.classList.add("down"); dot.textContent="×"; txt.textContent="disconnected";
  }
}

function setTrace(stateName){
  traceState=(stateName==="active")?"active":(stateName==="ended"?"ended":"idle");
  if(traceState==="active") setBanner("","live");
  else if(traceState==="ended") setBanner("trace ended — waiting for next trace…","ended");
  else setBanner("waiting for trace…","idle");
  if(connState==="connected") setConn("connected");
}

export function setBanner(text,kind){
  const b=document.getElementById("banner");
  if(!b)return;
  if(kind==="live"){ b.style.display="none"; b.className="banner"; return; }
  b.className="banner"+(kind==="ended"?" ended":"");
  b.textContent=text;
  b.style.display="block";
}

/* Clear plotted data + reset view for a fresh trace. */
function resetPlot(){
  for(const[,s]of sigs) s.data=[];
  state.viewT0=null; state.viewT1=null;
  fsState.stamps=[]; fsState.reported=null; fsState.lastShown="";
}

/* ---------- outbound commands ---------- */
export function wsSend(o){ if(ws&&ws.readyState===1) ws.send(JSON.stringify(o)); else toast("not connected — cannot send"); }
export function addSpecs(specs){
  const list=specs.map(s=>s.trim()).filter(Boolean);
  if(!list.length)return;
  wsSend({cmd:"add",signals:list});
}
export function removeSignal(name){ wsSend({cmd:"remove",signals:[name]}); }
