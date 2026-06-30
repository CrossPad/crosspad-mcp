/* Symbol autocomplete data source ("podpowiedzi zmiennych").
   Fetches /symbols (PROTOCOL §8/§9) and builds a flat, deduped suggestion list
   + a name→metadata map. The watchlist module renders the actual dropdown from
   this data; here we only fetch and shape. Free-form expansion specs the user
   types (vec[*], vec[a:b], mat[*][k]) are never blocked — suggestions only
   ASSIST; the server expands whatever is actually submitted. */

import { bus } from "./state.js";

let suggestList = [];                 // deduped suggestion strings (sorted)
export const symMeta = new Map();     // name -> §8 metadata entry
export function getSuggestList(){ return suggestList; }

/* Build suggestion strings from one symbol metadata entry (§8 shape). */
export function suggestionsForSymbol(sym){
  const out=[];
  const name=sym&&typeof sym.name==="string"?sym.name:null;
  if(!name)return out;
  const kind=sym.kind;
  if(kind==="array"){
    out.push(name);          // bare array name → whole-array expansion
    out.push(name+"[0]");    // first element
    out.push(name+"[*]");    // all elements (wildcard)
    if(Array.isArray(sym.dims)&&sym.dims.length>=2){
      out.push(name+"[0][0]");
      out.push(name+"[*][0]");
    }
  }else if(kind==="struct"||kind==="union"){
    out.push(name);
    if(Array.isArray(sym.members)){
      for(const mb of sym.members){ if(typeof mb==="string"&&mb) out.push(name+"."+mb); }
    }
  }else{
    out.push(name);          // scalar / other / unknown
  }
  return out;
}

/* Strip the [i]/[*]/.member suffix to get the base symbol name for metadata
   lookup. */
export function baseName(spec){
  const m=/^[A-Za-z_$][A-Za-z0-9_$]*/.exec(spec);
  return m?m[0]:spec;
}

/* A short metadata hint for a suggestion, e.g. "(8×, n=8)" or "(struct)". */
export function metaHint(spec){
  const meta=symMeta.get(baseName(spec));
  if(!meta)return "";
  if(meta.kind==="array"){
    const dims=Array.isArray(meta.dims)?meta.dims.join("×")+", ":"";
    return "("+dims+"n="+(meta.count!=null?meta.count:"?")+")";
  }
  if(meta.kind==="struct"||meta.kind==="union") return "("+meta.kind+")";
  return "";
}

/* Fetch /symbols and rebuild the suggestion list. Degrades gracefully: any
   failure (older server, no active session, non-JSON) leaves autocomplete empty
   and manual entry still works. Notifies the view via bus.onSymbols so an open
   dropdown can refresh. */
export function loadSymbols(){
  fetch("/symbols").then(r=>{
    if(!r.ok) throw new Error("HTTP "+r.status);
    return r.json();
  }).then(j=>{
    const arr=(j&&Array.isArray(j.symbols))?j.symbols:[];
    const seen=new Set(); const list=[];
    symMeta.clear();
    for(const sym of arr){
      if(sym&&typeof sym.name==="string") symMeta.set(sym.name,sym);
      for(const sug of suggestionsForSymbol(sym)){
        if(!seen.has(sug)){ seen.add(sug); list.push(sug); }
      }
    }
    list.sort();
    suggestList=list;
    bus.onSymbols();
  }).catch(()=>{ /* no autocomplete — manual entry still works */ });
}
