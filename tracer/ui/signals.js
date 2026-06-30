/* Local model of the watched signal set: reconcile to the server's set, and
   append samples. The view is rebuilt via bus.rebuildList (assigned by the
   watchlist module) so this stays free of DOM concerns. */

import { sigs, cfg, nextColor, bus } from "./state.js";
import { toast } from "./util.js";
import { getSuggestList, loadSymbols } from "./symbols.js";

let symbolsRetried = false;

/* hello.signals are plain name strings; signals frames are full descriptors. */
export function toDesc(n){ return (n&&typeof n==="object")?n:{name:String(n)}; }

/* Make the local sigs map match `descs` exactly: add new (stable color, on),
   update fields, drop removed. `unresolved` (if any) is toasted so the user
   knows a spec didn't land. */
export function reconcile(descs, unresolved){
  const want=new Set(descs.map(d=>d.name));
  for(const n of [...sigs.keys()]) if(!want.has(n)) sigs.delete(n);
  for(const d of descs){
    let s=sigs.get(d.name);
    if(!s){ s={color:nextColor(),on:true,data:[]}; sigs.set(d.name,s); }
    if(d.address!=null) s.address=d.address;
    if(d.size!=null) s.size=d.size;
    if(d.encoding!=null) s.encoding=d.encoding;
  }
  if(unresolved && unresolved.length) toast("unresolved: "+unresolved.join(", "));
  bus.rebuildList();
  // If autocomplete is still empty (symbols fetched before a session was active),
  // retry once now that the server is clearly talking to a target.
  if(!getSuggestList().length && !symbolsRetried){ symbolsRetried=true; loadSymbols(); }
}

export function push(n,t,v){
  const s=sigs.get(n); if(!s)return;
  s.data.push({t,v});
  const cap=Math.max(10,cfg.maxSamples|0);
  if(s.data.length>cap) s.data.shift();
}
