/* Unified "Signals" panel: add row with a custom autocomplete dropdown, presets,
   and the live signal list (color / show-hide / name / encoding / remove / stats).
   Replaces the old native <datalist> (clunky, whole-field matching) and merges
   the former separate "Signals & stats" panel into one place.

   Rows are built with DOM nodes + textContent (signal names are server/spec
   strings) so nothing is interpolated into innerHTML. */

import { sigs, bus } from "./state.js";
import { cssid, hex6 } from "./util.js";
import { addSpecs, removeSignal, wsSend } from "./connection.js";
import { getSuggestList, symMeta, baseName, metaHint } from "./symbols.js";

const PRESETS=[
  ["ADC raw","s_adc_raw[0],s_adc_raw[1],s_adc_raw[2],s_adc_raw[3]"],
  ["Voltages","s_vbat_mv,s_vbus_stm_mv,s_vbus_esp_mv"],
  ["Pads","s_inputs[1],s_inputs[2]"],
  ["Pad pressure","s_inputs[3],s_inputs[4],s_inputs[5],s_inputs[6]"],
  ["Encoder","s_inputs[0]"],
  ["Buttons","s_inputs[44]"],
];

let inp=null, ac=null, list=null, empty=null;
let acItems=[];   // current dropdown specs
let acSel=-1;     // highlighted index (-1 = none)

/* ---------- live signal list ---------- */
function rowFor(name, s){
  const row=document.createElement("div");
  row.className="sig"+(s.on?"":" off");

  const color=document.createElement("input");
  color.type="color"; color.className="sw"; color.value=hex6(s.color); color.title="signal color";
  color.oninput=()=>{ s.color=color.value; };

  const cb=document.createElement("input");
  cb.type="checkbox"; cb.checked=!!s.on; cb.title="show / hide";
  cb.onchange=()=>{ s.on=cb.checked; row.classList.toggle("off",!s.on); };

  const nm=document.createElement("span");
  nm.className="signame"; nm.textContent=name; nm.title="click to show / hide";
  nm.onclick=()=>{ s.on=!s.on; cb.checked=s.on; row.classList.toggle("off",!s.on); };

  const enc=document.createElement("span");
  enc.className="enc"; if(s.encoding) enc.textContent=s.encoding;

  const rm=document.createElement("span");
  rm.className="rm"; rm.textContent="×"; rm.title="remove";
  rm.onclick=()=>removeSignal(name);

  const head=document.createElement("div");
  head.className="sighead";
  head.append(color, cb, nm, enc, rm);

  const stats=document.createElement("div");
  stats.className="stats"; stats.id="st-"+cssid(name);

  row.append(head, stats);
  return row;
}

/* Rebuild the list to match the current sigs map (assigned to bus.rebuildList). */
function buildList(){
  if(!list)return;
  list.textContent="";
  for(const [name,s] of sigs) list.appendChild(rowFor(name,s));
  if(empty) empty.style.display = sigs.size ? "none" : "block";
}

/* ---------- custom autocomplete dropdown ---------- */
/* Active comma-token around the caret; preserves earlier/later tokens. */
function tokenCtx(){
  const val=inp.value;
  const caret=(inp.selectionStart!=null)?inp.selectionStart:val.length;
  const start=val.lastIndexOf(",",caret-1)+1;
  let end=val.indexOf(",",caret); if(end<0)end=val.length;
  return { prefix:val.slice(0,start), token:val.slice(start,end).trim(), suffix:val.slice(end) };
}

function matchesFor(token){
  const all=getSuggestList();
  if(!token) return all.slice(0,200);
  const tl=token.toLowerCase(), pref=[], sub=[];
  for(const sgn of all){
    const sl=sgn.toLowerCase();
    if(sl.startsWith(tl)) pref.push(sgn);
    else if(sl.indexOf(tl)>=0) sub.push(sgn);
  }
  return pref.concat(sub).slice(0,200);
}

function renderDropdown(){
  if(!ac)return;
  const { token }=tokenCtx();
  acItems=matchesFor(token);
  acSel=-1;
  ac.textContent="";
  if(!acItems.length){ ac.hidden=true; return; }
  acItems.forEach((spec,i)=>{
    const opt=document.createElement("div");
    opt.className="ac-opt";
    const nm=document.createElement("span"); nm.className="ac-spec"; nm.textContent=spec;
    opt.appendChild(nm);
    const hint=metaHint(spec);
    if(hint){ const h=document.createElement("span"); h.className="ac-hint"; h.textContent=hint; opt.appendChild(h); }
    // mousedown (not click) so it fires before the input blur closes the list.
    opt.addEventListener("mousedown",(e)=>{ e.preventDefault(); accept(i); });
    ac.appendChild(opt);
  });
  ac.hidden=false;
}

function highlight(i){
  const opts=ac.children;
  if(acSel>=0&&opts[acSel]) opts[acSel].classList.remove("sel");
  acSel=i;
  if(acSel>=0&&opts[acSel]){ opts[acSel].classList.add("sel"); opts[acSel].scrollIntoView({block:"nearest"}); }
}

/* Accept suggestion `i`: replace the active token, keep focus, re-suggest. */
function accept(i){
  const spec=acItems[i]; if(spec==null)return;
  const { prefix, suffix }=tokenCtx();
  const lead=prefix.length?(prefix.replace(/\s*$/,"")+" "):"";
  inp.value=lead+spec+suffix;
  const caret=lead.length+spec.length;
  inp.focus(); inp.setSelectionRange(caret,caret);
  renderDropdown();
}

function closeDropdown(){ if(ac){ ac.hidden=true; acSel=-1; } }

function submitAdd(){
  const specs=inp.value.split(",");
  if(specs.some(s=>s.trim())){ addSpecs(specs); inp.value=""; }
  closeDropdown();
}

/* ---------- init ---------- */
export function initWatchlist(){
  inp=document.getElementById("addInput");
  ac=document.getElementById("ac");
  list=document.getElementById("siglist");
  empty=document.getElementById("noSigs");

  document.getElementById("addBtn").onclick=submitAdd;

  inp.addEventListener("input",renderDropdown);
  inp.addEventListener("click",renderDropdown);
  inp.addEventListener("focus",renderDropdown);
  inp.addEventListener("blur",()=>setTimeout(closeDropdown,120));
  inp.addEventListener("keydown",(e)=>{
    if(ac && !ac.hidden && acItems.length){
      if(e.key==="ArrowDown"){ e.preventDefault(); highlight((acSel+1)%acItems.length); return; }
      if(e.key==="ArrowUp"){ e.preventDefault(); highlight((acSel-1+acItems.length)%acItems.length); return; }
      if(e.key==="Escape"){ closeDropdown(); return; }
      if(e.key==="Enter" && acSel>=0){ e.preventDefault(); accept(acSel); return; }
    }
    if(e.key==="Enter"){ submitAdd(); }
  });

  // presets
  const box=document.getElementById("presets");
  for(const [label,specs] of PRESETS){
    const b=document.createElement("button");
    b.textContent=label; b.title=specs;
    b.onclick=()=>addSpecs(specs.split(","));
    box.appendChild(b);
  }
  document.getElementById("clearAll").onclick=()=>{
    const names=[...sigs.keys()];
    if(names.length) wsSend({cmd:"remove",signals:names});
  };

  // register view hooks + initial paint
  bus.rebuildList=buildList;
  bus.onSymbols=()=>{ if(ac && !ac.hidden) renderDropdown(); };
  buildList();
}
