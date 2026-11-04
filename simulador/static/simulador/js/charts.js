/* =====================================================================
   charts.js · Dibujos SVG de Aire Claro (sin librerías externas)
   ---------------------------------------------------------------------
   · escena()            fondo semántico que cambia con el nivel del aire
   ===================================================================== */
(function () {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";
  const fmt = (x, d = 1) =>
    Number(x).toLocaleString("es-CO", { minimumFractionDigits: d, maximumFractionDigits: d });
  function el(tag, attrs = {}, padre) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (padre) padre.appendChild(n);
    return n;
  }
  // 1. ESCENA: fondo semántico sobrio, sin siluetas de edificios
  // ===================================================================
  const NIVEL_ESCENA = {
    fondo:      ["#e3efff", "#e8f1fb", "#f0f1f5", "#f8ecea", "#f0eafa"],
  };

  function escena(contenedor) {
    const W = 640, H = 300;
    contenedor.innerHTML = "";
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "xMidYMid slice", "aria-hidden": "true" }, contenedor);
    const defs = el("defs", {}, svg);
    const gradiente = el("linearGradient", { id: "fondo-aire", x1: 0, y1: 0, x2: 1, y2: 1 }, defs);
    el("stop", { class: "tono-inicial", offset: "0%", "stop-color": NIVEL_ESCENA.fondo[0] }, gradiente);
    el("stop", { class: "tono-final", offset: "100%", "stop-color": "#fff" }, gradiente);
    el("rect", { class: "cielo", width: W, height: H, fill: "url(#fondo-aire)" }, svg);
    function actualizar(nivel) {
      const n = Number.isInteger(nivel) ? Math.max(0, Math.min(4, nivel)) : null;
      svg.querySelector(".tono-inicial").setAttribute("stop-color", n === null ? "#edf1f3" : NIVEL_ESCENA.fondo[n]);
      svg.querySelector(".tono-final").setAttribute("stop-color", n === null ? "#f4f7fc" : n < 2 ? "#f4f8ff" : "#fffafa");
    }
    actualizar(null);
    return { actualizar };
  }

  // ===================================================================
  window.Graficos = { escena, fmt };
})();
