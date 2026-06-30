/* Shared mutable state + small data singletons for the trace dashboard.
   Reassignable scalars (paused / view overrides / hover) live on the `state`
   object so any module can update them — ESM exports are read-only bindings for
   importers, but object PROPERTIES are freely mutable, which is exactly what the
   render loop, input handlers, and toolbar all need. */

export const state = {
  paused: false,
  // Manual view overrides; null = follow the live trailing window / auto-Y.
  viewT0: null, viewT1: null,   // time pan/zoom (and pause-freeze)
  viewY0: null, viewY1: null,   // shared-mode Y zoom (Shift+wheel)
  // Crosshair: canvas-space mouse position while hovering (null = not hovering).
  hoverX: null, hoverY: null,
};

/* Client-side config (mirrors the side-panel controls). */
export const cfg = { windowSec: 15, full: false, maxSamples: 100000, yMode: "shared" };

/* sigs: name -> {color,on,data:[{t,v}],address?,size?,encoding?} */
export const sigs = new Map();

/* ---------- palette + stable color assignment ----------
   Colors rotate by index so a signal keeps its color across reconciles even as
   others are added/removed. */
const palette = ["#4af","#fa4","#4f8","#f48","#af4","#8af","#fd4","#f84","#6df","#d6f","#9f6","#f96"];
let colorIdx = 0;
export function nextColor(){ return palette[(colorIdx++) % palette.length]; }

/* ---------- global Fs (PROTOCOL §10) ----------
   Sample rate is a property of the whole trace, estimated once from the spacing
   of incoming sample-frame timestamps (a short ring → smoothed rate). An
   explicit `actual_fs`/`fs` from a frame is authoritative and wins. */
export const fsState = { stamps: [], reported: null, lastShown: "" };
const FS_RING = 64;
export function fsNoteSample(t){
  if(typeof t!=="number"||!isFinite(t))return;
  const r=fsState.stamps;
  if(r.length && t<=r[r.length-1]) return;   // ignore dup/out-of-order
  r.push(t);
  if(r.length>FS_RING) r.shift();
}
export function fsEstimate(){
  if(fsState.reported!=null && isFinite(fsState.reported) && fsState.reported>0) return fsState.reported;
  const r=fsState.stamps;
  if(r.length<2) return null;
  const dt=r[r.length-1]-r[0];
  if(!(dt>0)) return null;
  return (r.length-1)/dt;
}

/* ---------- UI hooks (decouple data/connection layers from the view) ----------
   The view layer assigns these; data/connection layers call them. Keeps the
   module graph acyclic (no connection→view import). */
export const bus = {
  rebuildList: () => {},   // signal set changed → rebuild the Signals panel
  onSymbols:   () => {},   // /symbols (re)loaded → refresh an open dropdown
};
