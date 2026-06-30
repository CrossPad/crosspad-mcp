/* Per-signal value-domain stats over the visible window, plus the single global
   Fs readout. VALUE-DOMAIN metrics only (cur/min/max/mean/p2p/rms/n). Sample
   rate is a whole-trace property shown once in the top bar (PROTOCOL §10). */

import { sigs, fsState, fsEstimate } from "./state.js";
import { fmt, cssid } from "./util.js";

export function statsFor(s,t0,t1){
  let n=0,sum=0,sq=0,mn=Infinity,mx=-Infinity,cur=null;
  const d=s.data;
  for(let i=0;i<d.length;i++){
    const p=d[i];
    if(p.t<t0||p.t>t1) continue;
    n++; sum+=p.v; sq+=p.v*p.v;
    if(p.v<mn)mn=p.v; if(p.v>mx)mx=p.v;
    cur=p.v;
  }
  if(n===0){
    cur=d.length?d[d.length-1].v:null;
    return {n:0,cur,min:null,max:null,mean:null,p2p:null,rms:null};
  }
  const mean=sum/n;
  const rms=Math.sqrt(sq/n);
  return {n,cur,min:mn,max:mx,mean,p2p:mx-mn,rms};
}

let lastStatsAt=0;
/* Refresh per-row stats cells (#st-<id>) + the global Fs readout, throttled. */
export function updateStats(t0,t1){
  const now=performance.now();
  if(now-lastStatsAt<200)return; // ~5 Hz, cheap
  lastStatsAt=now;
  for(const [n,s] of sigs){
    const cell=document.getElementById("st-"+cssid(n));
    if(!cell)continue;
    const st=statsFor(s,t0,t1);
    cell.innerHTML=
      `<span>cur <b>${fmt(st.cur)}</b></span>`+
      `<span>min <b>${fmt(st.min)}</b></span>`+
      `<span>max <b>${fmt(st.max)}</b></span>`+
      `<span>mean <b>${fmt(st.mean)}</b></span>`+
      `<span>p2p <b>${fmt(st.p2p)}</b></span>`+
      `<span>rms <b>${fmt(st.rms)}</b></span>`+
      `<span>n <b>${st.n}</b></span>`;
  }
  const fsEl=document.getElementById("fs");
  if(fsEl){
    const f=fsEstimate();
    const txt="Fs "+(f!=null?fmt(f)+" Hz":"—");
    if(txt!==fsState.lastShown){ fsEl.textContent=txt; fsState.lastShown=txt; }
  }
}
