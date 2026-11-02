/* =====================================================================
   charts.js · Dibujos SVG de Aire Claro (sin librerías externas)
   ---------------------------------------------------------------------
   · escena()            fondo semántico que cambia con el nivel del aire
   · diana()             tiro al blanco: entre más cerca del centro, menos falla
   · barrasDivergentes() aportes SHAP (solo en modo técnico)
   ===================================================================== */
(function () {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";
  const fmt = (x, d = 1) =>
    Number(x).toLocaleString("es-CO", { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtSigno = (x, d = 2) => (x >= 0 ? "+" : "−") + fmt(Math.abs(x), d);

  function el(tag, attrs = {}, padre) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (padre) padre.appendChild(n);
    return n;
  }
  function texto(padre, x, y, contenido, attrs = {}) {
    const t = el("text", { x, y, ...attrs }, padre);
    t.textContent = contenido;
    return t;
  }
  // Tooltip compartido: filas [[clave, valor], ...]
  function conTooltip(nodo, titulo, filas) {
    const tt = () => document.getElementById("tooltip");
    const mover = (ev) => {
      const t = tt();
      t.style.left = Math.min(ev.clientX + 14, innerWidth - t.offsetWidth - 8) + "px";
      t.style.top = Math.min(ev.clientY + 14, innerHeight - t.offsetHeight - 8) + "px";
    };
    const mostrar = (ev) => {
      const t = tt();
      t.innerHTML = `<b>${titulo}</b>` + filas.map(([k, v]) =>
        `<div class="tt-fila"><span>${k}</span><span>${v}</span></div>`).join("");
      t.hidden = false; mover(ev);
    };
    nodo.addEventListener("mouseenter", mostrar);
    nodo.addEventListener("mousemove", mover);
    nodo.addEventListener("mouseleave", () => (tt().hidden = true));
    nodo.setAttribute("tabindex", "0");
    nodo.addEventListener("focus", () => { const r = nodo.getBoundingClientRect(); mostrar({ clientX: r.right, clientY: r.top }); });
    nodo.addEventListener("blur", () => (tt().hidden = true));
  }

  // ===================================================================
  // 1. ESCENA: fondo semántico sobrio, sin siluetas de edificios
  // ===================================================================
  const NIVEL_ESCENA = {
    fondo:      ["#e7f4e9", "#f4f2df", "#fff0df", "#fbe8e6", "#eee8f5"],
    acento:     ["#26734d", "#8a7418", "#a95b27", "#a33d3d", "#704593"],
    sol:        [1, .85, .55, .3, .12],
  };

  function escena(contenedor) {
    const W = 640, H = 300;
    contenedor.innerHTML = "";
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Fondo de color según la calidad del aire" }, contenedor);
    const defs = el("defs", {}, svg);
    const gradiente = el("linearGradient", { id: "fondo-aire", x1: 0, y1: 0, x2: 1, y2: 1 }, defs);
    el("stop", { class: "tono-inicial", offset: "0%", "stop-color": NIVEL_ESCENA.fondo[0] }, gradiente);
    el("stop", { class: "tono-final", offset: "100%", "stop-color": "#fff" }, gradiente);
    el("rect", { class: "cielo", width: W, height: H, fill: "url(#fondo-aire)" }, svg);
    el("circle", { cx: 500, cy: 110, r: 145, fill: "#fff", opacity: .46 }, svg);
    const sol = el("g", { class: "sol" }, svg);
    el("circle", { cx: 535, cy: 82, r: 54, fill: "#fff", opacity: .72 }, sol);
    el("circle", { cx: 535, cy: 82, r: 34, fill: "#fff", opacity: .9 }, sol);
    const flujo = el("g", { class: "flujo", fill: "none", "stroke-width": 5, "stroke-linecap": "round" }, svg);
    [
      "M92 112h184c26 0 26-38 0-38h-24",
      "M60 151h250c30 0 30 42 0 42h-30",
      "M112 224h150c23 0 23-32 0-32",
    ].forEach((d) => el("path", { d }, flujo));

    function actualizar(nivel) {
      const n = Math.max(0, Math.min(4, nivel));
      svg.querySelector(".tono-inicial").setAttribute("stop-color", NIVEL_ESCENA.fondo[n]);
      svg.querySelector(".tono-final").setAttribute("stop-color", n < 2 ? "#f8fcf8" : "#fffafa");
      sol.setAttribute("opacity", NIVEL_ESCENA.sol[n]);
      flujo.setAttribute("stroke", NIVEL_ESCENA.acento[n]);
      flujo.setAttribute("opacity", .56);
    }
    actualizar(0);
    return { actualizar };
  }

  // ===================================================================
  // 2. DIANA: cada método es un dardo; distancia al centro = cuánto falla
  //    modelos: [{id, nombre, mae, elegido, color}]
  // ===================================================================
  function diana(contenedor, modelos, { unidad = "µg/m³" } = {}) {
    const S = 420, C = S / 2, R = 186;
    contenedor.innerHTML = "";
    const svg = el("svg", { viewBox: `0 0 ${S} ${S}`, role: "img", "aria-label": "Tiro al blanco: entre más cerca del centro, menos se equivoca" }, contenedor);
    const anillos = ["#e9eeec", "#f5f7f6", "#e9eeec", "#f5f7f6"];
    anillos.forEach((f, i) => el("circle", { cx: C, cy: C, r: R * (1 - i * .24), fill: f, stroke: "#d5dcd9" }, svg));
    el("circle", { cx: C, cy: C, r: 24, fill: "#ffd54f", stroke: "#e0b62e", "stroke-width": 2 }, svg);
    // Distancia relativa: el que menos falla queda junto al centro y el que más
    // falla en el borde (el valor exacto se ve al pasar el cursor).
    const maes = modelos.map((m) => m.mae);
    const lo = Math.min(...maes), hi = Math.max(...maes);
    const radio = (mae) => R * (0.22 + 0.7 * ((mae - lo) / ((hi - lo) || 1)));
    const angulos = [-40, 35, 145, 215, 280, 100, 0];
    const ordenados = [...modelos].sort((a, b) => a.mae - b.mae);
    ordenados.forEach((m, i) => {
      const ang = (angulos[i % angulos.length] * Math.PI) / 180;
      const rad = radio(m.mae);
      const x = C + rad * Math.cos(ang), y = C + rad * Math.sin(ang);
      const g = el("g", { class: "dardo", style: `transform: translate(${S}px, ${-S}px); opacity:0` }, svg);
      el("line", { x1: x, y1: y, x2: x + 22, y2: y - 22, stroke: "#4b5a56", "stroke-width": 2.5, "stroke-linecap": "round" }, g);
      el("path", { d: `M${x + 18} ${y - 26} l10 -2 l-2 10 z`, fill: m.color }, g);
      el("circle", { cx: x, cy: y, r: m.elegido ? 12 : 9, fill: m.color, stroke: "#fff", "stroke-width": 3 }, g);
      if (m.elegido) texto(g, x, y + 30, "Elegido", { "text-anchor": "middle", "font-size": 13, "font-weight": 700, fill: "#10201c" });
      conTooltip(g, m.nombre, [["Se equivoca en promedio", `± ${fmt(m.mae, 2)} ${unidad}`]]);
      // «Lanzamiento» escalonado
      setTimeout(() => { g.style.transform = "translate(0,0)"; g.style.opacity = 1; }, 150 + i * 180);
    });
  }

  // ===================================================================
  // 3. BARRAS DIVERGENTES (modo técnico): aporte SHAP por variable
  // ===================================================================
  function barrasDivergentes(contenedor, items, { unidad = "µg/m³" } = {}) {
    const W = 760, colEtq = 170, fila = 30, H = items.length * fila + 30;
    contenedor.innerHTML = "";
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Aportes SHAP" }, contenedor);
    const maxAbs = Math.max(...items.map((i) => Math.abs(i.valor)), 0.01);
    const x = (v) => colEtq + 10 + ((v + maxAbs) / (2 * maxAbs)) * (W - colEtq - 80);
    const css = getComputedStyle(document.documentElement);
    const cSube = css.getPropertyValue("--ensucia").trim(), cBaja = css.getPropertyValue("--limpia").trim();
    [-maxAbs, maxAbs].forEach((v) => texto(svg, x(v), H - 6, fmtSigno(v, 1), { "text-anchor": "middle", class: "t-tenue" }));
    items.forEach((it, i) => {
      const y = 6 + i * fila;
      const g = el("g", {}, svg);
      texto(g, colEtq, y + 15, it.etiqueta, { "text-anchor": "end", class: "t-fuerte" });
      const x0 = x(0), x1 = x(it.valor);
      el("rect", { x: Math.min(x0, x1), y: y + 3, width: Math.max(Math.abs(x1 - x0), 1), height: 16, rx: 3, fill: it.valor >= 0 ? cSube : cBaja }, g);
      texto(g, it.valor >= 0 ? x1 + 6 : x1 - 6, y + 16, fmtSigno(it.valor), { "text-anchor": it.valor >= 0 ? "start" : "end" });
      conTooltip(g, it.etiqueta, it.tooltip || []);
    });
    el("line", { x1: x(0), x2: x(0), y1: 0, y2: H - 20, class: "linea-cero" }, svg);
  }

  window.Graficos = { escena, diana, barrasDivergentes, fmt, fmtSigno };
})();
