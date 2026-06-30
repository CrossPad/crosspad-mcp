/* Canvas rendering + plot interaction (zoom/pan/hover). Owns the render loop,
   the visible-range math, signal paths, lane mode, the crosshair overlay, and
   the grid. View/hover overrides live on the shared `state` object. */

import { state, sigs, cfg } from "./state.js";
import { fmt, nearestSample } from "./util.js";
import { updateStats } from "./stats.js";

let cv=null, ctx=null;

/* Render-style knobs, swapped up during PNG export (thicker lines, lighter grid,
   bigger fonts) and restored after. S scales fonts; the export canvas is also
   drawn at a higher pixel size for a sharp, legible image. */
let LW=1.25;            // signal line width
let GRID="#1c1c1c";     // grid line color
let S=1;                // font scale

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

/* Value bounds across all on-signals' full history (for the Y pan/zoom clamp). */
function valueBounds(){
  let lo=Infinity,hi=-Infinity;
  for(const[,s]of sigs){if(!s.on)continue;for(const p of s.data){if(p.v<lo)lo=p.v;if(p.v>hi)hi=p.v;}}
  return[lo,hi];
}

/* Clamp a manual [a,b] override against data [lo,hi]: never wider than the data
   (snap to full), never panned past either edge. Returns clamped [a,b] or null
   when there's nothing to clamp. */
function clampSpan(a,b,lo,hi){
  if(a==null||!isFinite(lo)||hi<=lo)return null;
  const span=b-a; if(!(span>0))return null;
  if(span>=hi-lo)return[lo,hi];          // can't zoom out past all data
  if(a<lo){ a=lo; b=lo+span; }
  if(b>hi){ b=hi; a=hi-span; }
  return[a,b];
}

/* Keep the manual time view inside the data's time extent — you can't scroll the
   signal off-screen or pan into empty space beyond where it reaches. */
function clampViewTime(){
  const [lo,hi]=dataBounds();
  const c=clampSpan(state.viewT0,state.viewT1,lo,hi);
  if(c){ state.viewT0=c[0]; state.viewT1=c[1]; }
}
/* Same for the shared-mode Y override (Shift+wheel). */
function clampViewY(){
  const [lo,hi]=valueBounds();
  const c=clampSpan(state.viewY0,state.viewY1,lo,hi);
  if(c){ state.viewY0=c[0]; state.viewY1=c[1]; }
}

/* Stroke one signal's visible polyline. step=true → zero-order hold (logic look). */
function plotPath(s,X,Y,t0,t1,step){
  ctx.strokeStyle=s.color;ctx.lineWidth=LW;ctx.beginPath();
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

/* Lane mode: stack each visible signal in its own auto-scaled band with a colored
   label. DISCRETE signals (all-integer, small range — bits / flags) render as a
   zero-order-hold staircase (the logic-analyzer look); ANALOG signals render with
   straight interpolation like shared mode, so they don't look artificially blocky.
   Returns plotted [{n,s,Y}]. */
function renderLanesPath(visible,t0,t1,X,W,H){
  const plotted=[];const n=visible.length; if(!n)return plotted;
  const laneH=H/n, m=6;
  for(let i=0;i<n;i++){
    const [name,s]=visible[i];
    const top=i*laneH, bot=(i+1)*laneH;
    if(i>0){ctx.strokeStyle="#1c1c1c";ctx.lineWidth=1;
      ctx.beginPath();ctx.moveTo(0,top+0.5);ctx.lineTo(W,top+0.5);ctx.stroke();}
    let lo=Infinity,hi=-Infinity,allInt=true;
    for(const p of s.data){if(p.t<t0||p.t>t1)continue;
      if(p.v<lo)lo=p.v;if(p.v>hi)hi=p.v;
      if(allInt&&!Number.isInteger(p.v))allInt=false;}
    if(!isFinite(lo)){lo=0;hi=1;} if(hi===lo)hi=lo+1;
    const span=(hi-lo)||1;
    const Y=(v)=>bot-m-((v-lo)/span)*(laneH-2*m);
    const stepMode = allInt && (hi-lo)<=16;   // discrete → staircase; analog → linear
    plotPath(s,X,Y,t0,t1,stepMode);
    plotted.push({n:name,s,Y});
    ctx.font=`${10*S}px monospace`;
    const lw=ctx.measureText(name).width+6*S;
    ctx.fillStyle="#000a";ctx.fillRect(2*S,top+2*S,lw,12*S);
    ctx.fillStyle=s.color;ctx.fillText(name,5*S,top+11*S);
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
  drawLegend(plotted,X,W,hover,hoverT);
}

/* On-canvas legend box (top-right): color + name, plus the value at the cursor
   while hovering (also draws a dot on each curve). Shared by the live overlay
   and the PNG export (always-on, no crosshair). */
function drawLegend(plotted,X,W,hover,hoverT){
  const rows=[];
  for(const pl of plotted){
    let val=null;
    if(hover){
      const p=nearestSample(pl.s.data,hoverT);
      if(p){val=p.v; const x=X(p.t),y=pl.Y(p.v);
        if(isFinite(x)&&isFinite(y)){
          ctx.fillStyle=pl.s.color;ctx.beginPath();ctx.arc(x,y,3*S,0,Math.PI*2);ctx.fill();
          ctx.strokeStyle="#000";ctx.lineWidth=1;ctx.stroke();
        }}
    }
    rows.push({name:pl.n,color:pl.s.color,val});
  }
  if(!rows.length)return;
  ctx.save();ctx.font=`${11*S}px monospace`;
  let maxName=0;for(const r of rows)maxName=Math.max(maxName,ctx.measureText(r.name).width);
  let maxVal=0;if(hover)for(const r of rows)maxVal=Math.max(maxVal,ctx.measureText(fmt(r.val)).width);
  const pad=6*S,sw=9*S,gap=8*S,lh=14*S;
  const boxW=pad+sw+5*S+maxName+(hover?gap+maxVal:0)+pad;
  const boxH=pad+rows.length*lh+pad-2*S;
  const bx=W-boxW-6*S,by=6*S;
  ctx.fillStyle="#000a";ctx.fillRect(bx,by,boxW,boxH);
  ctx.strokeStyle="#2a2a2a";ctx.strokeRect(bx+0.5,by+0.5,boxW,boxH);
  let y=by+pad+9*S;
  for(const r of rows){
    ctx.fillStyle=r.color;ctx.fillRect(bx+pad,y-8*S,sw,sw);
    ctx.fillStyle="#ccc";ctx.fillText(r.name,bx+pad+sw+5*S,y);
    if(hover){ctx.fillStyle="#fff";ctx.fillText(fmt(r.val),bx+pad+sw+5*S+maxName+gap,y);}
    y+=lh;
  }
  ctx.restore();
}

/* ---------- grid / axes ---------- */
function drawGrid(t0,t1,W,H,ylo,yhi){
  ctx.strokeStyle=GRID;ctx.lineWidth=1;ctx.fillStyle="#888";ctx.font=`${10*S}px monospace`;
  for(let i=0;i<=6;i++){
    const x=W*i/6; ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();
    const tt=t0+(t1-t0)*i/6;
    ctx.fillText(tt.toFixed(2)+"s",Math.min(x+2*S,W-40*S),H-2*S);
  }
  if(cfg.yMode==="shared"){
    for(let i=0;i<=4;i++){
      const y=H*i/4; ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();
      const vv=yhi-(yhi-ylo)*i/4;
      ctx.fillText(fmt(vv),2*S,Math.max(10*S,y+10*S));
    }
  }
}

/* Paint grid + every visible signal for the current view into the active canvas
   (cv/ctx). Returns the `plotted` list ({n,s,Y}) for overlays. Shared by the
   live render loop and the PNG exporter. */
function paintSignals(t0,t1,W,H){
  const span=(t1-t0)||1;
  const X=(t)=>(t-t0)/span*W;
  const visible=[...sigs].filter(([,s])=>s.on);
  if(cfg.yMode==="lanes"){
    drawGrid(t0,t1,W,H,0,1);
    return { X, plotted: renderLanesPath(visible,t0,t1,X,W,H) };
  }
  const [ylo,yhi]=sharedYBounds(t0,t1);
  const yspan=(yhi-ylo)||1;
  const sharedY=(v)=>H-(v-ylo)/yspan*H;
  drawGrid(t0,t1,W,H,ylo,yhi);
  const plotted=[];
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
  return { X, plotted };
}

/* ---------- render loop ---------- */
function render(){
  requestAnimationFrame(render);
  if(!ctx)return;
  ctx.clearRect(0,0,cv.width,cv.height);
  const [t0,t1]=curRange();
  const W=cv.width,H=cv.height;
  const { X, plotted }=paintSignals(t0,t1,W,H);
  drawOverlay(plotted,t0,t1,X,W,H);
  updateStats(t0,t1);
}

/* ---------- PNG export ----------
   Render a sharp, high-contrast, self-contained image to an offscreen canvas:
   2× pixel scale, thicker lines, lighter grid, an always-on legend (so the saved
   image identifies its signals), and a title strip with the date, time window,
   and Fs. Returns the offscreen canvas for toBlob. */
export function renderExport(fsText){
  const SC=2;                                  // pixel + font scale
  const W=(cv.width||800)*SC, H=(cv.height||400)*SC;
  const off=document.createElement("canvas"); off.width=W; off.height=H;
  const offCtx=off.getContext("2d");
  const sCv=cv,sCtx=ctx,sLW=LW,sGRID=GRID,sS=S;
  cv=off; ctx=offCtx; LW=2.2*SC; GRID="#333"; S=SC;
  try{
    offCtx.fillStyle="#0c0c0c"; offCtx.fillRect(0,0,W,H);
    const titleH=22*SC;
    const [t0,t1]=curRange();
    // plot below the title strip
    offCtx.save(); offCtx.translate(0,titleH);
    const { X, plotted }=paintSignals(t0,t1,W,H-titleH);
    drawLegend(plotted,X,W,false,null);        // always-on legend, no crosshair
    offCtx.restore();
    // title strip
    offCtx.fillStyle="#141414"; offCtx.fillRect(0,0,W,titleH);
    offCtx.strokeStyle="#2a2a2a"; offCtx.beginPath();offCtx.moveTo(0,titleH-0.5);offCtx.lineTo(W,titleH-0.5);offCtx.stroke();
    offCtx.fillStyle="#bcd"; offCtx.font=`${12*SC}px monospace`; offCtx.textBaseline="middle";
    const stamp=new Date().toLocaleString();
    const title=`CrossPad SWD trace · ${stamp} · ${t0.toFixed(2)}–${t1.toFixed(2)}s · ${cfg.yMode}${fsText?` · ${fsText}`:""}`;
    offCtx.fillText(title,8*SC,titleH/2);
    offCtx.textBaseline="alphabetic";
  } finally {
    cv=sCv;ctx=sCtx;LW=sLW;GRID=sGRID;S=sS;
  }
  return off;
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
        clampViewY();
      }else{
        const f=e.deltaY<0?0.8:1.25;
        const cx=t0+span*(e.offsetX/W);
        state.viewT0=cx-(cx-t0)*f; state.viewT1=cx+(t1-cx)*f;
        clampViewTime();
      }
    }
    if(e.deltaX){
      const dt=(e.deltaX/W)*span;
      const [a,b]=(state.viewT0!=null)?[state.viewT0,state.viewT1]:[t0,t1];
      state.viewT0=a+dt; state.viewT1=b+dt;
      clampViewTime();
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
    clampViewTime();
  });
  cv.addEventListener("mouseleave",()=>{ state.hoverX=null; state.hoverY=null; });

  render();
}
