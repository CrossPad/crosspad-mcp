/* Canvas rendering + plot interaction (zoom/pan/hover). Owns the render loop,
   the visible-range math, signal paths, lane mode, the crosshair overlay, and
   the grid. View/hover overrides live on the shared `state` object. */

import { state, sigs, cfg } from "./state.js";
import { fmt, nearestSample } from "./util.js";
import { updateStats } from "./stats.js";

let cv=null, ctx=null;

/* Resize the backing store to the element's CSS size. */
export function fit(){ if(cv){ cv.width=cv.clientWidth; cv.height=cv.clientHeight; } }

/* ---------- visible time range ---------- */
function dataBounds(){
  let lo=Infinity,hi=-Infinity;
  for(const[,s]of sigs){const d=s.data;if(d.length){if(d[0].t<lo)lo=d[0].t;if(d[d.length-1].t>hi)hi=d[d.length-1].t;}}
  return [lo,hi];
}
export function curRange(){
  const [lo,hi]=dataBounds();
  if(!isFinite(lo))return[0,1];
  if(state.viewT0!=null)return[state.viewT0,state.viewT1];
  if(cfg.full)return[lo,hi>lo?hi:lo+1];
  return[Math.max(lo,hi-cfg.windowSec),hi];
}

/* Shared-mode Y bounds: manual override (Shift+wheel) wins, else auto-fit. */
export function sharedYBounds(t0,t1){
  if(state.viewY0!=null&&state.viewY1!=null)return[state.viewY0,state.viewY1];
  let lo=Infinity,hi=-Infinity;
  for(const[,s]of sigs){if(!s.on)continue;
    for(const p of s.data){if(p.t<t0||p.t>t1)continue;if(p.v<lo)lo=p.v;if(p.v>hi)hi=p.v;}}
  if(!isFinite(lo)){lo=0;hi=1;}
  if(hi===lo)hi=lo+1;
  return[lo,hi];
}

/* Stroke one signal's visible polyline. step=true → zero-order hold (logic look). */
function plotPath(s,X,Y,t0,t1,step){
  ctx.strokeStyle=s.color;ctx.lineWidth=1.25;ctx.beginPath();
  const d=s.data;let first=true,py=0;
  for(let i=0;i<d.length;i++){
    const p=d[i]; if(p.t<t0||p.t>t1)continue;
    const x=X(p.t),y=Y(p.v);
    if(first){ctx.moveTo(x,y);first=false;}
    else{ if(step)ctx.lineTo(x,py); ctx.lineTo(x,y); }
    py=y;
  }
  ctx.stroke();
}

/* Lane (logic-analyzer) mode: stack each visible signal in its own auto-scaled,
   step-rendered band with a colored label. Returns plotted [{n,s,Y}]. */
function renderLanesPath(visible,t0,t1,X,W,H){
  const plotted=[];const n=visible.length; if(!n)return plotted;
  const laneH=H/n, m=6;
  for(let i=0;i<n;i++){
    const [name,s]=visible[i];
    const top=i*laneH, bot=(i+1)*laneH;
    if(i>0){ctx.strokeStyle="#1c1c1c";ctx.lineWidth=1;
      ctx.beginPath();ctx.moveTo(0,top+0.5);ctx.lineTo(W,top+0.5);ctx.stroke();}
    let lo=Infinity,hi=-Infinity;
    for(const p of s.data){if(p.t<t0||p.t>t1)continue;if(p.v<lo)lo=p.v;if(p.v>hi)hi=p.v;}
    if(!isFinite(lo)){lo=0;hi=1;} if(hi===lo)hi=lo+1;
    const span=(hi-lo)||1;
    const Y=(v)=>bot-m-((v-lo)/span)*(laneH-2*m);
    plotPath(s,X,Y,t0,t1,true);
    plotted.push({n:name,s,Y});
    ctx.font="10px monospace";
    const lw=ctx.measureText(name).width+6;
    ctx.fillStyle="#000a";ctx.fillRect(2,top+2,lw,12);
    ctx.fillStyle=s.color;ctx.fillText(name,5,top+11);
  }
  return plotted;
}

/* Crosshair + on-canvas legend overlay (top-right). The legend always identifies
   colors; while hovering it also shows each signal's value at the cursor time,
   draws a dot on each curve, and a dashed vertical line + time label. */
function drawOverlay(plotted,t0,t1,X,W,H){
  const span=(t1-t0)||1;
  const hx=state.hoverX;
  const hover=hx!=null&&hx>=0&&hx<=W;
  const hoverT=hover?t0+(hx/W)*span:null;
  if(hover){
    ctx.save();
    ctx.strokeStyle="#888";ctx.lineWidth=1;ctx.setLineDash([4,3]);
    ctx.beginPath();ctx.moveTo(hx+0.5,0);ctx.lineTo(hx+0.5,H);ctx.stroke();
    ctx.setLineDash([]);
    const tl=hoverT.toFixed(3)+"s"; ctx.font="10px monospace";
    const tw=ctx.measureText(tl).width+6; let lx=hx+4; if(lx+tw>W)lx=hx-4-tw;
    ctx.fillStyle="#000c";ctx.fillRect(lx,2,tw,13);
    ctx.fillStyle="#bbb";ctx.fillText(tl,lx+3,12);
    ctx.restore();
  }
  const rows=[];
  for(const pl of plotted){
    let val=null;
    if(hover){
      const p=nearestSample(pl.s.data,hoverT);
      if(p){val=p.v; const x=X(p.t),y=pl.Y(p.v);
        if(isFinite(x)&&isFinite(y)){
          ctx.fillStyle=pl.s.color;ctx.beginPath();ctx.arc(x,y,3,0,Math.PI*2);ctx.fill();
          ctx.strokeStyle="#000";ctx.lineWidth=1;ctx.stroke();
        }}
    }
    rows.push({name:pl.n,color:pl.s.color,val});
  }
  if(!rows.length)return;
  ctx.save();ctx.font="11px monospace";
  let maxName=0;for(const r of rows)maxName=Math.max(maxName,ctx.measureText(r.name).width);
  let maxVal=0;if(hover)for(const r of rows)maxVal=Math.max(maxVal,ctx.measureText(fmt(r.val)).width);
  const pad=6,sw=9,gap=8,lh=14;
  const boxW=pad+sw+5+maxName+(hover?gap+maxVal:0)+pad;
  const boxH=pad+rows.length*lh+pad-2;
  const bx=W-boxW-6,by=6;
  ctx.fillStyle="#000a";ctx.fillRect(bx,by,boxW,boxH);
  ctx.strokeStyle="#2a2a2a";ctx.strokeRect(bx+0.5,by+0.5,boxW,boxH);
  let y=by+pad+9;
  for(const r of rows){
    ctx.fillStyle=r.color;ctx.fillRect(bx+pad,y-8,sw,sw);
    ctx.fillStyle="#ccc";ctx.fillText(r.name,bx+pad+sw+5,y);
    if(hover){ctx.fillStyle="#fff";ctx.fillText(fmt(r.val),bx+pad+sw+5+maxName+gap,y);}
    y+=lh;
  }
  ctx.restore();
}

/* ---------- grid / axes ---------- */
function drawGrid(t0,t1,W,H,ylo,yhi){
  ctx.strokeStyle="#1c1c1c";ctx.lineWidth=1;ctx.fillStyle="#666";ctx.font="10px monospace";
  for(let i=0;i<=6;i++){
    const x=W*i/6; ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();
    const tt=t0+(t1-t0)*i/6;
    ctx.fillText(tt.toFixed(2)+"s",Math.min(x+2,W-40),H-2);
  }
  if(cfg.yMode==="shared"){
    for(let i=0;i<=4;i++){
      const y=H*i/4; ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();
      const vv=yhi-(yhi-ylo)*i/4;
      ctx.fillText(fmt(vv),2,Math.max(10,y+10));
    }
  }
}

/* ---------- render loop ---------- */
function render(){
  requestAnimationFrame(render);
  if(!ctx)return;
  ctx.clearRect(0,0,cv.width,cv.height);
  const [t0,t1]=curRange();const span=(t1-t0)||1;
  const W=cv.width,H=cv.height;
  const X=(t)=>(t-t0)/span*W;
  const visible=[...sigs].filter(([,s])=>s.on);

  let plotted;
  if(cfg.yMode==="lanes"){
    drawGrid(t0,t1,W,H,0,1);
    plotted=renderLanesPath(visible,t0,t1,X,W,H);
  }else{
    const [ylo,yhi]=sharedYBounds(t0,t1);
    const yspan=(yhi-ylo)||1;
    const sharedY=(v)=>H-(v-ylo)/yspan*H;
    drawGrid(t0,t1,W,H,ylo,yhi);
    plotted=[];
    for(const[n,s] of visible){
      let Y=sharedY;
      if(cfg.yMode==="norm"){
        let smn=Infinity,smx=-Infinity;
        for(const p of s.data){if(p.t<t0||p.t>t1)continue;if(p.v<smn)smn=p.v;if(p.v>smx)smx=p.v;}
        if(!isFinite(smn)){smn=0;smx=1;}
        const ss=(smx-smn)||1;
        Y=(v)=>H-((v-smn)/ss)*(H-8)-4;
      }
      plotPath(s,X,Y,t0,t1,false);
      plotted.push({n,s,Y});
    }
  }
  drawOverlay(plotted,t0,t1,X,W,H);
  updateStats(t0,t1);
}

/* ---------- init: grab canvas, wire input, start the loop ----------
   Both wheel axes are honored: deltaY zooms time (Shift+deltaY zooms shared Y),
   deltaX (horizontal/tilt wheel) pans time. A 2-D scroll applies both. */
export function initPlot(){
  cv=document.getElementById("cv");
  ctx=cv.getContext("2d");
  window.addEventListener("resize",fit);
  fit();

  cv.addEventListener("wheel",(e)=>{e.preventDefault();
    const W=cv.width||1, H=cv.height||1;
    const [t0,t1]=curRange();const span=(t1-t0)||1;
    if(e.deltaY){
      if(e.shiftKey && cfg.yMode==="shared"){
        const [y0,y1]=sharedYBounds(t0,t1);const yspan=(y1-y0)||1;
        const f=e.deltaY<0?0.8:1.25;
        const cy=y1-(e.offsetY/H)*yspan;
        state.viewY0=cy-(cy-y0)*f; state.viewY1=cy+(y1-cy)*f;
      }else{
        const f=e.deltaY<0?0.8:1.25;
        const cx=t0+span*(e.offsetX/W);
        state.viewT0=cx-(cx-t0)*f; state.viewT1=cx+(t1-cx)*f;
      }
    }
    if(e.deltaX){
      const dt=(e.deltaX/W)*span;
      const [a,b]=(state.viewT0!=null)?[state.viewT0,state.viewT1]:[t0,t1];
      state.viewT0=a+dt; state.viewT1=b+dt;
    }
  },{passive:false});

  let drag=null;
  cv.addEventListener("mousedown",(e)=>drag={x:e.offsetX,r:curRange()});
  window.addEventListener("mouseup",()=>drag=null);
  cv.addEventListener("mousemove",(e)=>{
    state.hoverX=e.offsetX; state.hoverY=e.offsetY;
    if(!drag)return;
    const [t0,t1]=drag.r;const span=t1-t0;const dt=(e.offsetX-drag.x)/cv.width*span;
    state.viewT0=t0-dt;state.viewT1=t1-dt;
  });
  cv.addEventListener("mouseleave",()=>{ state.hoverX=null; state.hoverY=null; });

  render();
}
