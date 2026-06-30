/* Entry point: wire the modules, paint initial state, open the socket, start the
   render loop. Imported as a module from index.html. */

import { initPlot } from "./plot.js";
import { connect, setConn, setBanner } from "./connection.js";
import { initWatchlist } from "./watchlist.js";
import { initConfig } from "./config.js";
import { initToolbar } from "./toolbar.js";
import { loadSymbols } from "./symbols.js";

/* Collapsible side panels. */
function initPanels(){
  document.querySelectorAll(".panel h3[data-tgl]").forEach(h=>{
    h.onclick=()=>{
      const p=h.parentElement; p.classList.toggle("collapsed");
      const arr=h.querySelector(".arrow"); if(arr) arr.textContent=p.classList.contains("collapsed")?"▸":"▾";
    };
  });
}

initConfig();
initWatchlist();
initToolbar();
initPanels();
initPlot();              // grabs the canvas, wires input, starts the render loop

setConn("reconnecting"); // initial indicator paint before the first open
setBanner("connecting…","idle");
connect();
loadSymbols();           // populate autocomplete (graceful if unavailable)
