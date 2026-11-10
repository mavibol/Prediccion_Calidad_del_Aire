/* Pantalla «Resultados del modelo» (objetivo específico 3).
   Pide /api/resultados/ una sola vez y dibuja:
   indicadores clave, pronóstico vs. realidad, validación temporal,
   factores que más pesan (SHAP global), aporte del clima y días críticos. */
(function () {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const CONFIG = JSON.parse($("#config-front").textContent);
  const ico = (n, c = "icon") => window.Iconos.svg(n, c);
  const num = (x, d = 1) => Number(x).toLocaleString("es-CO", { minimumFractionDigits: d, maximumFractionDigits: d });
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const fecha = (iso, conDia = true) => {
    const [a, m, d] = iso.split("-").map(Number);
    return conDia ? `${d} ${MESES[m - 1]} ${a}` : `${MESES[m - 1]} ${a}`;
  };
  const COLORES_GRUPO = { particulas: "#3979c6", gases: "#8fb0d9", aerosoles: "#c6d6ea", clima: "#1f9e8f", calendario: "#d8dee8" };

  let datos = null;
  let actual = "pm2_5";
  let cargando = false;

  async function mostrar() {
    if (datos) return pintar();
    if (cargando) return;
    cargando = true;
    try {
      const r = await fetch(CONFIG.api.resultados, { headers: { Accept: "application/json" } });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      datos = j.resultados;
      $("#res-cargando").hidden = true;
      $("#res-contenido").hidden = false;
      pintar();
    } catch (e) {
      $("#res-cargando").textContent = "No fue posible cargar los resultados: " + (e.message || "error desconocido");
    } finally {
      cargando = false;
    }
  }

  function pintar() {
    const c = datos.contaminantes[actual];
    const prueba = datos.particion.find((p) => p.id === "prueba");
    let anchoPrevio = 0;
  window.addEventListener("resize", () => {
    const caja = $("#res-grafico");
    if (!datos || !caja || $("#vista-resultados").hidden) return;
    if (Math.abs(caja.clientWidth - anchoPrevio) > 40) {
      anchoPrevio = caja.clientWidth;
      grafico(caja, datos.contaminantes[actual]);
    }
  });

  document.querySelectorAll(".res-segmento__btn").forEach((b) => {
      const activo = b.dataset.contaminante === actual;
      b.classList.toggle("activo", activo);
      b.setAttribute("aria-pressed", String(activo));
    });

    $("#res-contenido").innerHTML = `
      <div class="res-kpis">
        ${kpi("ruler", `± ${num(c.modelo.mae)}`, "µg/m³", "Error promedio por día",
              `MAE · RMSE ${num(c.modelo.rmse)} µg/m³`)}
        ${kpi("award", `${num(c.mejora, 0)} %`, "", "Mejor que repetir el dato de ayer",
              `Persistencia: error de ${num(c.persistencia.mae)} µg/m³`)}
        ${kpi("checkCircle", `${prueba.dias}`, "días", "Evaluados con datos nuevos",
              `${fecha(prueba.desde)} – ${fecha(prueba.hasta)}`)}
      </div>

      <section class="tarjeta res-panel">
        <header class="res-panel__cab">
          <div>
            <h2 class="res-panel__titulo">Pronóstico vs. realidad</h2>
            <p class="res-panel__sub">Cada punto es un día del periodo de prueba. El modelo explica el
              ${num(c.modelo.r2 * 100, 0)} % de la variación diaria (R² ${num(c.modelo.r2, 2)}).</p>
          </div>
          <div class="res-leyenda">
            <span><i style="background:var(--res-obs)"></i>Medido</span>
            <span><i style="background:var(--acento)"></i>Pronosticado (${esc(c.algoritmo)})</span>
            <span><i class="res-leyenda__guion"></i>Día crítico (P90)</span>
          </div>
        </header>
        <div class="res-grafico" id="res-grafico"></div>
        ${lineaTiempo()}
      </section>

      <div class="res-dos">
        <section class="tarjeta res-panel">
          <h2 class="res-panel__titulo">¿En qué se fija el modelo?</h2>
          <p class="res-panel__sub">Peso de cada tipo de dato en los ${prueba.dias} pronósticos (importancia SHAP global).</p>
          ${barraGrupos(c.grupos)}
          <h3 class="res-subtitulo">Los factores que más pesan</h3>
          <ol class="res-factores">${c.factores.slice(0, 5).map(factor).join("")}</ol>
        </section>
        <section class="tarjeta res-panel">
          <h2 class="res-panel__titulo">¿Qué aportó el clima?</h2>
          ${escenarios(c)}
        </section>
      </div>

      ${criticos(c)}
    `;
    grafico($("#res-grafico"), c);
  }

  function kpi(icono, valor, unidad, titulo, detalle) {
    return `<div class="tarjeta res-kpi">
        <span class="res-kpi__ico">${ico(icono)}</span>
        <p class="res-kpi__valor">${valor}${unidad ? ` <small>${unidad}</small>` : ""}</p>
        <p class="res-kpi__titulo">${titulo}</p>
        <p class="res-kpi__detalle">${detalle}</p>
      </div>`;
  }

  function lineaTiempo() {
    const total = datos.particion.reduce((s, p) => s + p.dias, 0);
    return `<div class="res-tiempo">
        <p class="res-tiempo__titulo">Así se evaluó <span>· validación temporal</span></p>
        <div class="res-tiempo__barra">
          ${datos.particion.map((p) => `<span class="res-tiempo__tramo res-tiempo__tramo--${p.id}" style="flex:${p.dias / total}"></span>`).join("")}
        </div>
        <div class="res-tiempo__etiquetas">
          ${datos.particion.map((p) => `<div style="flex:${p.dias / total}" class="res-tiempo__etq res-tiempo__etq--${p.id}">
              <b>${p.nombre}</b><span>${p.dias} días · ${fecha(p.desde, false)} – ${fecha(p.hasta, false)}</span></div>`).join("")}
        </div>
        <p class="res-tiempo__nota">El modelo aprendió con el pasado y se puso a prueba con los meses siguientes,
          en orden cronológico, como pasaría en la vida real.</p>
      </div>`;
  }

  function barraGrupos(grupos) {
    const orden = [...grupos].sort((a, b) => b.peso - a.peso);
    return `<div class="res-grupos" role="img" aria-label="${orden.map((g) => `${g.nombre} ${num(g.peso, 0)} %`).join(", ")}">
        ${orden.map((g) => `<span style="flex:${g.peso};background:${COLORES_GRUPO[g.id]}" title="${esc(g.nombre)}: ${num(g.peso, 0)} %"></span>`).join("")}
      </div>
      <ul class="res-grupos__leyenda">
        ${orden.map((g) => `<li><i style="background:${COLORES_GRUPO[g.id]}"></i>${esc(g.nombre)} <b>${num(g.peso, 0)} %</b></li>`).join("")}
      </ul>`;
  }

  function factor(f) {
    const max = datos.contaminantes[actual].factores[0].peso;
    return `<li class="res-factor${f.tipo === "clima" ? " res-factor--clima" : ""}">
        <span class="res-factor__ico">${ico(f.icono)}</span>
        <span class="res-factor__nombre">${esc(f.nombre)}${f.tipo === "clima" ? ' <em>Clima</em>' : ""}</span>
        <span class="res-factor__barra"><i style="width:${(f.peso / max) * 100}%"></i></span>
        <b>${num(f.peso, 0)} %</b>
      </li>`;
  }

  function escenarios(c) {
    if (!c.escenarios) {
      return `<p class="res-panel__sub">El modelo desplegado no usa variables meteorológicas.</p>`;
    }
    const { A, C } = c.escenarios;
    const menosError = (1 - C.mae / A.mae) * 100;
    const fila = (titulo, d, elegido) => `<div class="res-esc${elegido ? " res-esc--elegido" : ""}">
        <div class="res-esc__nombre">${titulo}<small>${d.modelo}</small></div>
        <div class="res-esc__dato"><b>${num(d.mae, 2)}</b><small>error (µg/m³)</small></div>
        <div class="res-esc__dato"><b>${num(d.r2, 2)}</b><small>R²</small></div>
        ${elegido ? `<span class="res-esc__sello">${ico("checkCircle")} Elegido</span>` : ""}
      </div>`;
    return `<p class="res-panel__sub">Comparación en validación entre el modelo sin clima (escenario A) y con
        el pronóstico del clima (escenario C).</p>
      ${fila("Sin clima", A, false)}
      ${fila("Con clima", C, true)}
      <p class="res-esc__mensaje">${ico("arrowDown")}<span>Con el clima el error bajó un <b>${num(menosError, 0)} %</b>
        y el modelo pasó a explicar el <b>${num(C.r2 * 100, 0)} %</b> de la variación (antes ${num(A.r2 * 100, 0)} %).</span></p>
      <p class="res-panel__nota">Se compararon ${datos.modelos_comparados.join(", ").replace(/, ([^,]*)$/, " y $1")};
        ${esc(C.modelo)} fue el más preciso.</p>`;
  }

  function criticos(c) {
    const k = c.criticos;
    if (!k.dias) return "";
    const pocos = k.dias < 5
      ? ` Fueron muy pocos días, así que este resultado es poco representativo.` : "";
    return `<section class="tarjeta res-alerta">
        <span class="res-alerta__ico">${ico("triangleAlert")}</span>
        <div>
          <h2 class="res-panel__titulo">En los días más contaminados</h2>
          <p>Hubo <b>${k.dias} días</b> con ${c.etiqueta} por encima de ${num(k.umbral)} µg/m³ (el 10 % más alto del entrenamiento). En ellos el error sube a <b>${num(k.mae)} µg/m³</b> y el pronóstico se queda
            ${k.sesgo < 0 ? "corto" : "alto"} en ${num(Math.abs(k.sesgo))} µg/m³ en promedio. ${
              k.mae >= k.mae_persistencia
                ? `En estos días el modelo no es mejor que repetir el dato de ayer (error de ${num(k.mae_persistencia)} µg/m³): es la principal limitación del pronóstico.`
                : `Repetir el dato de ayer se equivoca ${num(k.mae_persistencia)} µg/m³, así que el modelo mejora algo, pero no alcanza toda la magnitud de los picos.`}${pocos}</p>        </div>
      </section>`;
  }

  /* ---------- Gráfico SVG: observado vs. pronosticado ---------- */
  function grafico(caja, c) {
    // El ancho del dibujo sigue al de la tarjeta, para que en el celular el texto no se encoja
    const W = Math.max(320, Math.round(caja.clientWidth || 900));
    const H = W < 600 ? 240 : 280, M = { t: 14, r: 10, b: 30, l: 36 };
    const { fechas, observado: obs, pronostico: pre } = c.serie;
    const n = fechas.length;
    const ymax = Math.ceil(Math.max(...obs, ...pre, c.criticos.umbral) / 5) * 5 + 2;
    const x = (i) => M.l + (i / (n - 1)) * (W - M.l - M.r);
    const y = (v) => H - M.b - (v / ymax) * (H - M.t - M.b);
    const linea = (serie) => serie.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
    const paso = ymax > 40 ? 20 : ymax > 20 ? 10 : 5;
    let ejes = "";
    for (let v = 0; v <= ymax; v += paso) {
      ejes += `<line x1="${M.l}" x2="${W - M.r}" y1="${y(v)}" y2="${y(v)}" class="res-g__rejilla"/>
               <text x="${M.l - 8}" y="${y(v) + 4}" text-anchor="end" class="res-g__texto">${v}</text>`;
    }
    const cadaMes = W < 600 ? 2 : 1;      // en pantallas angostas, un mes sí y uno no
    let mesN = 0;
    fechas.forEach((f, i) => {
      if (f.endsWith("-01") && mesN++ % cadaMes === 0) {
        ejes += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" class="res-g__texto">${fecha(f, false)}</text>`;
      }
    });
    caja.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" class="res-g" role="img"
           aria-label="Concentración medida y pronosticada de ${esc(c.etiqueta)} en los ${n} días de prueba">
        ${ejes}
        <text x="${M.l}" y="${M.t - 2}" class="res-g__texto">µg/m³</text>
        <line x1="${M.l}" x2="${W - M.r}" y1="${y(c.criticos.umbral)}" y2="${y(c.criticos.umbral)}" class="res-g__p90"/>
        <path d="${linea(obs)}" class="res-g__obs"/>
        <path d="${linea(pre)}" class="res-g__pre"/>
        <line class="res-g__cursor" y1="${M.t}" y2="${H - M.b}" visibility="hidden"/>
        <circle r="4" class="res-g__punto res-g__punto--obs" visibility="hidden"/>
        <circle r="4" class="res-g__punto res-g__punto--pre" visibility="hidden"/>
        <rect x="${M.l}" y="${M.t}" width="${W - M.l - M.r}" height="${H - M.t - M.b}" fill="transparent" class="res-g__zona"/>
      </svg>
      <div class="res-g__tip" hidden></div>`;
    const svg = $("svg", caja), tip = $(".res-g__tip", caja);
    const cursor = $(".res-g__cursor", svg), po = $(".res-g__punto--obs", svg), pp = $(".res-g__punto--pre", svg);
    const mover = (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const i = Math.max(0, Math.min(n - 1, Math.round(((px - M.l) / (W - M.l - M.r)) * (n - 1))));
      [cursor, po, pp].forEach((e) => e.setAttribute("visibility", "visible"));
      cursor.setAttribute("x1", x(i)); cursor.setAttribute("x2", x(i));
      po.setAttribute("cx", x(i)); po.setAttribute("cy", y(obs[i]));
      pp.setAttribute("cx", x(i)); pp.setAttribute("cy", y(pre[i]));
      tip.hidden = false;
      tip.innerHTML = `<b>${fecha(fechas[i])}</b><span>Medido: ${num(obs[i])}</span><span>Pronosticado: ${num(pre[i])}</span>`;
      const izq = (x(i) / W) * r.width;
      tip.style.left = `${Math.min(Math.max(izq, 70), r.width - 70)}px`;
    };
    const salir = () => { tip.hidden = true; [cursor, po, pp].forEach((e) => e.setAttribute("visibility", "hidden")); };
    $(".res-g__zona", svg).addEventListener("pointermove", mover);
    $(".res-g__zona", svg).addEventListener("pointerleave", salir);
  }

  let anchoPrevio = 0;
  window.addEventListener("resize", () => {
    const caja = $("#res-grafico");
    if (!datos || !caja || $("#vista-resultados").hidden) return;
    if (Math.abs(caja.clientWidth - anchoPrevio) > 40) {
      anchoPrevio = caja.clientWidth;
      grafico(caja, datos.contaminantes[actual]);
    }
  });

  document.querySelectorAll(".res-segmento__btn").forEach((b) =>
    b.addEventListener("click", () => { actual = b.dataset.contaminante; if (datos) pintar(); }));

  window.Resultados = { mostrar };
})();