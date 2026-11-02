/* =====================================================================
   charts.js · Dibujos SVG de Aire Claro (sin librerías externas)
   ---------------------------------------------------------------------
   · escena()            fondo semántico que cambia con el nivel del aire
   · diana()             tiro al blanco: entre más cerca del centro, menos falla
   · cascadaSHAP()      descomposición interactiva base → predicción
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

  function cascadaSHAP(contenedor, base, prediccion, items, { unidad = "µg/m³" } = {}) {
    const W = 940, margenIzq = 250, margenDer = 125, altoFila = 29;
    const filas = items.length + 2;
    const alto = filas * altoFila + 46;
    const recorrido = [];
    let acumulado = base;
    for (const item of items) {
      const inicio = acumulado;
      acumulado += item.aporte;
      recorrido.push({ ...item, inicio, fin: acumulado });
    }

    const extremos = [0, base, prediccion, ...recorrido.flatMap((item) => [item.inicio, item.fin])];
    let minimo = Math.min(...extremos), maximo = Math.max(...extremos);
    const margen = (maximo - minimo || 1) * .06;
    minimo -= margen;
    maximo += margen;
    const x = (v) => margenIzq + ((v - minimo) / (maximo - minimo)) * (W - margenIzq - margenDer);
    const colorFavorable = getComputedStyle(document.documentElement).getPropertyValue("--aporte-favorable").trim();
    const colorDesfavorable = getComputedStyle(document.documentElement).getPropertyValue("--aporte-desfavorable").trim();
    contenedor.innerHTML = "";
    const svg = el("svg", {
      viewBox: `0 0 ${W} ${alto}`,
      role: "img",
      "aria-label": `Cascada SHAP: valor base ${fmt(base, 4)}, ${items.length} aportes y predicción ${fmt(prediccion, 4)} ${unidad}`,
    }, contenedor);

    const pasos = 5;
    for (let i = 0; i <= pasos; i++) {
      const valor = minimo + (maximo - minimo) * i / pasos;
      const pos = x(valor);
      el("line", { x1: pos, x2: pos, y1: 0, y2: alto - 34, class: "rejilla" }, svg);
      texto(svg, pos, alto - 8, fmt(valor, 2), { "text-anchor": "middle", class: "t-tenue" });
    }
    el("line", { x1: x(0), x2: x(0), y1: 0, y2: alto - 34, class: "linea-cero" }, svg);

    const filaBarra = (y, inicio, fin, color, etiqueta, valor, tooltip) => {
      const g = el("g", { class: "waterfall__item" }, svg);
      texto(g, margenIzq - 12, y + 17, etiqueta, { "text-anchor": "end", class: "t-fuerte" });
      const x0 = x(Math.min(inicio, fin)), x1 = x(Math.max(inicio, fin));
      el("rect", {
        x: x0, y: y + 5, width: Math.max(1, x1 - x0), height: 17, rx: 3, fill: color,
      }, g);
      texto(g, W - 8, y + 17, fmt(valor, 4), { "text-anchor": "end", class: "t-fuerte" });
      if (tooltip) conTooltip(g, etiqueta, tooltip);
      return g;
    };

    let y = 4;
    filaBarra(y, 0, base, "#82918b", "Base E[f(X)]", base, [
      ["Valor base", `${fmt(base, 4)} ${unidad}`],
    ]);
    y += altoFila;
    recorrido.forEach((item, index) => {
      const color = item.aporte < 0 ? colorFavorable : colorDesfavorable;
      if (index > 0) {
        el("line", {
          x1: x(item.inicio), x2: x(item.inicio),
          y1: y - altoFila + 22, y2: y + 5, class: "waterfall__conector",
        }, svg);
      }
      filaBarra(y, item.inicio, item.fin, color, item.columna, item.aporte, [
        ["Aporte SHAP", `${fmtSigno(item.aporte, 4)} ${unidad}`],
        ["Origen", item.origen],
        ["Valor acumulado", `${fmt(item.fin, 4)} ${unidad}`],
      ]);
      y += altoFila;
    });
    filaBarra(y, 0, prediccion, "#1c5cab", "Predicción", prediccion, [
      ["Predicción", `${fmt(prediccion, 4)} ${unidad}`],
      ["Base + suma SHAP", `${fmt(base + items.reduce((suma, item) => suma + item.aporte, 0), 4)} ${unidad}`],
    ]);
  }

  window.Graficos = { escena, diana, cascadaSHAP, fmt, fmtSigno };
})();
