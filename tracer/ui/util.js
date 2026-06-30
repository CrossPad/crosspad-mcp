/* Pure helpers + the toast notifier. No app state — safe to import anywhere. */

export function esc(n){ return String(n).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }
export function cssid(n){ return n.replace(/[^a-z0-9]/gi,"_"); }
export function cssAttr(n){ return n.replace(/"/g,'\\"'); }

/* Expand a #rgb / #rrggbb color to the 6-digit form an <input type=color>
   requires (palette literals are 3-digit shorthand). Non-hex → safe default. */
export function hex6(c){
  if(typeof c!=="string")return "#4488ff";
  const m=/^#([0-9a-f]{3})$/i.exec(c);
  if(m){const s=m[1];return "#"+s[0]+s[0]+s[1]+s[1]+s[2]+s[2];}
  if(/^#[0-9a-f]{6}$/i.test(c))return c;
  return "#4488ff";
}

/* Compact numeric formatter for readouts/stats. */
export function fmt(x){
  if(x===null||x===undefined||!isFinite(x))return "—";
  const a=Math.abs(x);
  if(a!==0&&(a<0.01||a>=1e6))return x.toExponential(2);
  if(Number.isInteger(x))return String(x);
  return x.toFixed(a<1?4:2);
}

/* Binary-search the sample nearest a timestamp (data is time-sorted). Used by
   the crosshair readout. Returns null for an empty series. */
export function nearestSample(d,t){
  if(!d.length)return null;
  if(t<=d[0].t)return d[0];
  const last=d[d.length-1]; if(t>=last.t)return last;
  let lo=0,hi=d.length-1;
  while(lo<hi){const mid=(lo+hi)>>1; if(d[mid].t<t)lo=mid+1; else hi=mid;}
  const b=d[lo],a=d[lo-1]||b;
  return (t-a.t<=b.t-t)?a:b;
}

/* Trigger a client-side file download from a Blob. */
export function downloadBlob(name,blob){
  const a=document.createElement("a");
  const u=URL.createObjectURL(blob);
  a.href=u;a.download=name;document.body.appendChild(a);a.click();
  setTimeout(()=>{a.remove();URL.revokeObjectURL(u);},0);
}

/* Local timestamp for export filenames (YYYYMMDD-HHMMSS). */
export function tstamp(){
  const d=new Date();const p=n=>String(n).padStart(2,"0");
  return d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+"-"+p(d.getHours())+p(d.getMinutes())+p(d.getSeconds());
}

/* Transient toast (unresolved specs / errors / info). */
export function toast(msg,kind){
  const box=document.getElementById("toast");
  if(!box)return;
  const el=document.createElement("div");
  el.className="t"+(kind==="info"?" info":"");
  el.textContent=msg;
  box.appendChild(el);
  setTimeout(()=>{el.style.opacity="0";el.style.transition="opacity .4s";},kind==="info"?2500:4500);
  setTimeout(()=>el.remove(),kind==="info"?2900:4900);
}
