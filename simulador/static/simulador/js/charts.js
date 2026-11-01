/* =====================================================================
   charts.js · Dibujos SVG de Aire Claro (sin librerías externas)
   ---------------------------------------------------------------------
   · escena()            paisaje de la ciudad cuyo cielo cambia con el nivel
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
  // Números pseudoaleatorios con semilla: el paisaje se ve igual en cada carga
  function azar(semilla) {
    let s = semilla;
    return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
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
  // 1. ESCENA: el cielo de la ciudad
  //    Se dibuja una sola vez; actualizar(nivel) solo cambia colores,
  //    opacidades y partículas, con transiciones CSS suaves.
  // ===================================================================
  const NIVEL_ESCENA = {
    cielo:      ["#79c3f2", "#a7cde3", "#c9c1a2", "#b49e88", "#8c7884"],
    montana:    ["#86b6a2", "#93ae9e", "#a6a58e", "#a0917d", "#857580"],
    sol:        [1, .85, .55, .3, .12],
    bruma:      [0, .1, .26, .42, .58],
    particulas: [0, 10, 26, 46, 72],
    persona:    ["🚴", "🚴", "🚶", "😷", "🏠"],
  };

  function escena(contenedor) {
    const W = 640, H = 300, r = azar(7);
    contenedor.innerHTML = "";
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Cielo de la ciudad" }, contenedor);
    const defs = el("defs", {}, svg);
    const g = el("linearGradient", { id: "brillo", x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    el("stop", { offset: "45%", "stop-color": "#fff", "stop-opacity": 0 }, g);
    el("stop", { offset: "100%", "stop-color": "#fff", "stop-opacity": .45 }, g);

    const cielo = el("rect", { class: "cielo", width: W, height: H }, svg);
    el("rect", { width: W, height: H, fill: "url(#brillo)" }, svg);
    const sol = el("g", { class: "sol" }, svg);
    el("circle", { cx: 540, cy: 76, r: 56, fill: "#ffe082", opacity: .35 }, sol);
    el("circle", { cx: 540, cy: 76, r: 36, fill: "#ffd54f" }, sol);
    // Nubes
    [[120, 64, 1], [330, 44, .8]].forEach(([x, y, k]) => {
      const n = el("g", { opacity: .85 }, svg);
      [[0, 0, 26], [24, -10, 22], [48, 0, 24], [22, 8, 26]].forEach(([dx, dy, rr]) =>
        el("circle", { cx: x + dx * k, cy: y + dy * k, r: rr * k, fill: "#fff" }, n));
    });
    const montana = el("path", { class: "montana", d: "M0 205 L90 150 L170 192 L260 128 L360 198 L450 148 L560 188 L640 158 V300 H0Z" }, svg);

    // Edificios con ventanas
    let x = 0;
    const edificios = el("g", {}, svg);
    while (x < W) {
      const w = 34 + r() * 46, h = 40 + r() * 75;
      el("rect", { x, y: 270 - h, width: w - 4, height: h, fill: r() > .5 ? "#2e4440" : "#36504a", rx: 2 }, edificios);
      for (let wy = 270 - h + 10; wy < 258; wy += 16)
        for (let wx = x + 6; wx < x + w - 12; wx += 11)
          if (r() > .45) el("rect", { x: wx, y: wy, width: 5, height: 7, fill: "#ffe9a8", opacity: .75 }, edificios);
      x += w;
    }
    // Árboles y suelo
    for (let i = 0; i < 9; i++) {
      const tx = 30 + i * 72 + r() * 20;
      el("rect", { x: tx - 2, y: 258, width: 4, height: 14, fill: "#5b4636" }, svg);
      el("circle", { cx: tx, cy: 252, r: 11 + r() * 5, fill: "#3c8d5a" }, svg);
    }
    el("rect", { y: 270, width: W, height: 30, fill: "#4f6b5f" }, svg);
    const persona = texto(svg, 40, 290, "🚴", { class: "persona" });

    // Bruma y partículas (lo que «ensucia» el cielo)
    const bruma = el("rect", { class: "bruma", width: W, height: H, fill: "#8c7d6a", opacity: 0 }, svg);
    const parts = el("g", {}, svg);
    const particulas = Array.from({ length: 72 }, () =>
      el("circle", {
        class: "particula", cx: r() * W, cy: 10 + r() * 250, r: 1.5 + r() * 2.5, fill: "#5a4e45", opacity: 0,
        style: `--dur:${7 + r() * 8}s;--retraso:-${r() * 10}s`,
      }, parts));

    function actualizar(nivel) {
      const n = Math.max(0, Math.min(4, nivel));
      cielo.setAttribute("fill", NIVEL_ESCENA.cielo[n]);
      montana.setAttribute("fill", NIVEL_ESCENA.montana[n]);
      sol.setAttribute("opacity", NIVEL_ESCENA.sol[n]);
      bruma.setAttribute("opacity", NIVEL_ESCENA.bruma[n]);
      persona.textContent = NIVEL_ESCENA.persona[n];
      const visibles = NIVEL_ESCENA.particulas[n];
      particulas.forEach((p, i) => p.setAttribute("opacity", i < visibles ? .55 : 0));
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
      if (m.elegido) texto(g, x, y + 30, "⭐ elegido", { "text-anchor": "middle", "font-size": 13, "font-weight": 700, fill: "#10201c" });
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
