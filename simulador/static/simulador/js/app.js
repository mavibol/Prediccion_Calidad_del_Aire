/* =====================================================================
   app.js · Interfaz de Aire Claro para público general
   ---------------------------------------------------------------------
   Recorrido de los datos (detalle en DOCUMENTACION_FLUJO_DE_DATOS.md):

     1. Django incrusta el catálogo de variables en la página (json_script).
     2. El usuario agrega datos e introduce sus valores.
     3. Cada movimiento programa un cálculo (espera 250 ms a que se detenga).
     4. calcular() envía los pares [variable : valor] con fetch() a /api/predecir/.
     5. El servidor imputa lo que falta, predice y calcula SHAP.
     6. Se repinta: banner de estado, escala, recomendaciones y
        atribuciones TreeSHAP con su dirección y magnitud.

   Regla de diseño: el público ve estados, iconos y frases cortas.
   Las cifras quedan detrás del interruptor «Modo técnico».
   ===================================================================== */
(function () {
  "use strict";

  /* -----------------------------------------------------------------
     PASO 0 · Utilidades
     ----------------------------------------------------------------- */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const { fmt, fmtSigno } = window.Graficos;
  const icono = window.Iconos.svg;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // "12,5" o "12.5" se convierte a 12.5; "" se convierte a null; texto a NaN.
  function aNumero(txt) {
    const s = String(txt ?? "").trim().replace(/\s/g, "");
    if (s === "") return null;
    const n = s.includes(",") && s.includes(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(",", ".");
    return /^\d*\.?\d+$/.test(n) ? Number(n) : NaN;
  }
  const decimales = (v) => (v.max < 5 ? 2 : v.max < 100 ? 1 : 0);
  const memoria = {
    leer(k) { try { return localStorage.getItem(k); } catch { return null; } },
    guardar(k, v) { try { localStorage.setItem(k, v); } catch { /* sin persistencia */ } },
  };

  /* -----------------------------------------------------------------
     PASO 1 · Estado
     ----------------------------------------------------------------- */
  const CATALOGO = JSON.parse($("#catalogo-variables").textContent); // ya viene ordenado por importancia
  const CONFIG = JSON.parse($("#config-front").textContent);
  const PORID = Object.fromEntries(CATALOGO.map((v) => [v.id, v]));
  const CSRF = $('meta[name="csrf-token"]').content;
  const COLOR_NIVEL = ["#0ca30c", "#f2b005", "#ec835a", "#d03b3b", "#7d3c98"];
  const CARAS = [["checkCircle", "Limpio"], ["dotCircle", "Aceptable"], ["triangleAlert", "Regular"], ["shieldAlert", "Contaminado"], ["triangleAlert", "Peligroso"]];

  const estado = {
    filas: new Map(),      // id de variable a <li>
    resultado: null,       // última respuesta del servidor
    peticion: null,        // AbortController de la petición en curso
    temporizador: null,
    objetivoTec: "pm2_5",  // pestaña del modo técnico
    benchmark: null,
    escena: null,
  };

  /* -----------------------------------------------------------------
     PASO 2 · Navegación, menú y modo técnico
     ----------------------------------------------------------------- */
  const app = $("#app");
  if (memoria.leer("aire.colapsado") === "1") app.classList.add("colapsado");
  $("#btn-colapsar").addEventListener("click", () => {
    const col = app.classList.toggle("colapsado");
    $("#btn-colapsar").setAttribute("aria-expanded", String(!col));
    memoria.guardar("aire.colapsado", col ? "1" : "0");
  });
  const menuMovil = (abrir) => {
    app.classList.toggle("menu-abierto", abrir);
    $("#velo").hidden = !abrir;
    $("#btn-menu-movil").setAttribute("aria-expanded", String(abrir));
  };
  $("#btn-menu-movil").addEventListener("click", () => menuMovil(true));
  $("#velo").addEventListener("click", () => menuMovil(false));
  document.addEventListener("keydown", (e) => e.key === "Escape" && menuMovil(false));

  // Modo técnico: muestra cifras y gráficos SHAP para evaluadores
  const chkTec = $("#chk-tecnico");
  chkTec.checked = memoria.leer("aire.tecnico") === "1";
  document.body.classList.toggle("modo-tecnico", chkTec.checked);
  chkTec.addEventListener("change", () => {
    document.body.classList.toggle("modo-tecnico", chkTec.checked);
    memoria.guardar("aire.tecnico", chkTec.checked ? "1" : "0");
    repintarTodo();
  });

  function mostrarVista() {
    const pedida = (location.hash || "#simulador").slice(1);
    const vista = ["simulador", "explicabilidad", "modelos"].includes(pedida) ? pedida : "simulador";
    $$(".vista").forEach((s) => (s.hidden = s.id !== "vista-" + vista));
    $$(".nav-item").forEach((a) => {
      a.classList.toggle("activo", a.dataset.vista === vista);
      a.toggleAttribute("aria-current", a.dataset.vista === vista);
    });
    const sec = $("#vista-" + vista);
    $("#titulo-vista").textContent = sec.dataset.titulo;
    $("#subtitulo-vista").textContent = sec.dataset.sub;
    document.title = `${sec.dataset.titulo} · Aire Claro`;
    menuMovil(false);
    if (vista === "explicabilidad") pintarPorque();
    if (vista === "modelos") cargarBenchmark();
    window.scrollTo({ top: 0 });
  }
  window.addEventListener("hashchange", mostrarVista);

  function mostrarAviso(msg) { const a = $("#aviso-global"); a.textContent = msg || ""; a.hidden = !msg; }

  /* -----------------------------------------------------------------
     PASO 3 · Constructor dinámico de variables
     -----------------------------------------------------------------
     El <select> solo ofrece variables del dataset que aún no se han
     agregado. Cada variable agregada es una fila con barra + número.
     ----------------------------------------------------------------- */
  const selector = $("#selector-variable");
  const lista = $("#lista-variables");

  function poblarSelector() {
    const libres = CATALOGO.filter((v) => !estado.filas.has(v.id));
    selector.innerHTML = libres.length
      ? libres.map((v) => `<option value="${v.id}">${esc(v.etiqueta)} — ${esc(v.nombre_largo)} (${esc(v.unidad)})${v.estrellas === 3 ? " (más relevante)" : ""}</option>`).join("")
      : `<option value="">Ya agregaste todos los datos</option>`;
    selector.disabled = $("#btn-agregar").disabled = !libres.length;
    $("#btn-limpiar").hidden = estado.filas.size === 0;
  }

  // Texto y color del estado de un valor (misma regla que el servidor)
  function estadoDe(v, x) {
    if (v.umbral_seguro != null && x > v.umbral_seguro) return ["Por encima de lo saludable", "var(--n3)"];
    if (x > v.p90) return ["Más alto de lo normal", "var(--n1)"];
    if (x < v.p10) return ["Más bajo de lo normal", "var(--n0)"];
    return ["Normal en la ciudad", "var(--n0)"];
  }
  function agregarVariable(id, valor) {
    const v = PORID[id];
    if (!v || estado.filas.has(id)) return;
    const d = decimales(v);
    const inicial = valor ?? v.mediana;
    const li = document.createElement("li");
    li.className = "dato";
    li.dataset.variable = id;
    li.innerHTML = `
      <div class="dato__cab">
        <span class="dato__ico" aria-hidden="true">${icono(v.simple_icono, "icon")}</span>
        <span class="dato__nombre">${esc(v.etiqueta)} — ${esc(v.nombre_largo)}<small>Unidad: ${esc(v.unidad)}</small><small class="dato__alias">Nombre común: ${esc(v.simple_nombre)}</small></span>
        <button type="button" class="dato__info" aria-label="Más información sobre ${esc(v.etiqueta)}" aria-expanded="false">i</button>
        <button type="button" class="dato__quitar" aria-label="Quitar ${esc(v.etiqueta)}">${icono("x", "icon")}</button>
      </div>
      <p class="dato__que" hidden>${esc(v.simple_que_es)}</p>
      <div class="dato__control">
        <input type="text" class="campo dato__num" inputmode="decimal" aria-label="Valor de ${esc(v.etiqueta)} en ${esc(v.unidad)}"
               value="${fmt(inicial, d).replace(/\./g, "")}" autocomplete="off">
      </div>
      <div class="dato__estado"><i></i><span></span></div>`;

    const num = $(".dato__num", li);
    const pintarEstado = (x) => {
      const [txt, color] = estadoDe(v, x);
      $(".dato__estado span", li).textContent = txt;
      $(".dato__estado i", li).style.background = color;
    };
    pintarEstado(inicial);

    num.addEventListener("input", () => {
      const x = aNumero(num.value);
      const malo = x === null || !Number.isFinite(x) || x < 0;
      num.toggleAttribute("aria-invalid", malo);
      num.style.borderColor = malo ? "var(--n3)" : "";
      if (malo) return;
      pintarEstado(x);
      programarCalculo(500);
    });
    $(".dato__info", li).addEventListener("click", (e) => {
      const p = $(".dato__que", li);
      p.hidden = !p.hidden;
      e.currentTarget.setAttribute("aria-expanded", String(!p.hidden));
    });
    $(".dato__quitar", li).addEventListener("click", () => quitarVariable(id));

    lista.appendChild(li);
    estado.filas.set(id, li);
    poblarSelector();
    programarCalculo(0);
  }

  function quitarVariable(id) {
    const li = estado.filas.get(id);
    if (!li) return;
    estado.filas.delete(id);
    li.classList.add("saliendo");
    setTimeout(() => li.remove(), 200);
    poblarSelector();
    if (estado.filas.size) programarCalculo(0); else reiniciarResultados();
  }

  function reiniciarResultados() {
    if (estado.peticion) estado.peticion.abort();
    estado.resultado = null;
    $("#resultado").hidden = true;
    $("#bienvenida").hidden = false;
    $("#mini-estado").classList.remove("visible");
    mostrarAviso("");
  }

  $("#btn-agregar").addEventListener("click", () => selector.value && agregarVariable(selector.value));
  $("#btn-limpiar").addEventListener("click", () => {
    [...estado.filas.values()].forEach((li) => li.remove());
    estado.filas.clear();
    poblarSelector();
    reiniciarResultados();
  });
  // Ejemplos: llenan los 9 datos con valores típicos de la ciudad (P10 / mediana / P90)
  $$("[data-escenario]").forEach((b) => b.addEventListener("click", () => {
    [...estado.filas.values()].forEach((li) => li.remove());
    estado.filas.clear();
    CATALOGO.forEach((v) => agregarVariable(v.id, v[b.dataset.escenario]));
  }));

  /* -----------------------------------------------------------------
     PASO 4 · Lectura del formulario y envío con fetch()
     ----------------------------------------------------------------- */
  function leerFormulario() {
    const variables = [];
    for (const [id, li] of estado.filas) {
      const x = aNumero($(".dato__num", li).value);
      if (x === null || Number.isNaN(x)) return null; // el campo ya quedó marcado en rojo
      variables.push({ variable: id, valor: x });
    }
    return variables.length ? { variables } : null;
  }

  function programarCalculo(espera) {
    clearTimeout(estado.temporizador);
    estado.temporizador = setTimeout(calcular, espera);
  }

  async function calcular() {
    const payload = leerFormulario();
    if (!payload) return;
    if (estado.peticion) estado.peticion.abort(); // una respuesta vieja nunca pisa a una nueva
    const control = new AbortController();
    estado.peticion = control;
    try {
      const r = await fetch(CONFIG.api.predecir, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRFToken": CSRF },
        body: JSON.stringify(payload),
        signal: control.signal,
        credentials: "same-origin",
      });
      let datos;
      try { datos = await r.json(); } catch { datos = { ok: false, error: "El servidor no respondió bien." }; }
      if (!r.ok || !datos.ok) { mostrarAviso(datos.error || "No pudimos calcular. Intenta de nuevo."); return; }
      mostrarAviso("");
      estado.resultado = datos;
      pintarResultado(datos);
      if (!$("#vista-explicabilidad").hidden) pintarPorque();
    } catch (e) {
      if (e.name !== "AbortError") mostrarAviso("Sin conexión con el servidor. ¿Está encendido Django?");
    } finally {
      if (estado.peticion === control) estado.peticion = null;
    }
  }

  /* -----------------------------------------------------------------
     PASO 5 · Mi aire: cielo, escala, precisión, porqué y consejos
     ----------------------------------------------------------------- */
  function pintarResultado(d) {
    const a = d.alerta;
    $("#bienvenida").hidden = true;
    $("#resultado").hidden = false;

    // 5.1 El banner cambia de tono según el nivel
    if (!estado.escena) estado.escena = window.Graficos.escena($("#escena"));
    estado.escena.actualizar(a.orden);
    const ver = $("#veredicto");
    const clave = a.titulo + a.cara;
    if (ver.dataset.clave !== clave) { // solo «rebota» la cara si cambió el nivel
      ver.dataset.clave = clave;
      ver.innerHTML = `<span class="veredicto__cara" aria-hidden="true">${icono(a.cara, "icon")}</span>
        <span><span class="veredicto__titulo">${esc(a.titulo)}</span><br><span class="veredicto__frase">${esc(a.frase)}</span></span>`;
    }

    // 5.2 Escala de cinco estados (color + icono + palabra)
    $("#escala").innerHTML = CARAS.map(([cara, txt], i) => `
      <div class="escalon ${i === a.orden ? "activo" : ""}" style="color:${COLOR_NIVEL[i]}" ${i === a.orden ? 'aria-current="true"' : ""}>
        <span class="escalon__cara" aria-hidden="true">${icono(cara, "icon")}</span>
        <span class="escalon__txt" style="color:var(--tinta)">${txt}</span>
        <span class="escalon__barra" style="background:${COLOR_NIVEL[i]}"></span>
      </div>`).join("");

    $("#alerta-local").hidden = !a.dia_critico_local;
    $("#alerta-local").innerHTML = `${icono("triangleAlert", "icon")} Mañana el aire estaría más sucio que en 9 de cada 10 días de la ciudad.`;

    // 5.3 Completitud observada + sugerencia del dato más útil que falta
    const faltante = CATALOGO.find((v) => !estado.filas.has(v.id));
    const completas = d.entrada.completitud;
    $("#precision").innerHTML = `<h3>Datos ingresados</h3>
      <div class="completitud__valor">${completas.ingresadas} de ${completas.total} variables ingresadas <b>(${fmt(completas.porcentaje, 0)} %)</b></div>
      <div class="completitud__barra" role="meter" aria-label="Completitud de datos" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${completas.porcentaje}">
        <span style="width:${completas.porcentaje}%"></span></div>
      <span class="suave">Cobertura de importancia del modelo: ${fmt(d.cobertura.porcentaje, 1)} %; es una medida ponderada, no el porcentaje de variables ingresadas.</span>
      ${faltante && completas.ingresadas < completas.total ? `<button type="button" class="sugerencia" data-id="${faltante.id}">${icono("plus", "icon")} ${icono(faltante.simple_icono, "icon")} Agregar ${esc(faltante.etiqueta)} — ${esc(faltante.nombre_largo)}</button>` : ""}`;
    const sug = $(".sugerencia", $("#precision"));
    if (sug) sug.addEventListener("click", () => agregarVariable(sug.dataset.id));

    // 5.4 Resumen breve de las atribuciones TreeSHAP
    const s = d.explicacion[a.contaminante].simple;
    const fila = (f, favorable) => f ? `<div class="porque-mini__fila ${favorable ? "porque-mini__fila--favorable" : "porque-mini__fila--desfavorable"}">
        <span><strong>${esc(f.nombre)}</strong><small class="factor__comun">${favorable ? "Aporte favorable" : "Aporte desfavorable"} · ${fmtSigno(f.aporte, 1)} µg/m³</small></span></div>` : "";
    $("#porque-mini").innerHTML = `<h3>¿Por qué?</h3>${fila(s.desfavorables[0], false)}${fila(s.favorables[0], true)}
      ${!s.desfavorables.length && !s.favorables.length ? `<p class="suave">No hay aportes individuales relevantes.</p>` : ""}
      <span class="ver-mas">Ver la explicación ${icono("arrowRight", "icon")}</span>`;

    // 5.5 Consejos para hoy (máximo seis palabras cada uno)
    const SELLO = { si: "checkCircle", precaucion: "triangleAlert", no: "x" };
    $("#recomendaciones").innerHTML = d.recomendaciones.map((r) => `
      <div class="rec rec--${r.estado}" title="${esc(r.texto)}">
        <span class="rec__sello" aria-label="${r.estado === "si" ? "Sí" : r.estado === "no" ? "No" : "Con cuidado"}">${icono(SELLO[r.estado], "icon")}</span>
        <div class="rec__ico" aria-hidden="true">${icono(r.icono, "icon")}</div>
        <div class="rec__tit">${esc(r.etiqueta)}</div>
        <div class="rec__txt">${esc(r.corto)}</div>
      </div>`).join("");

    // 5.6 Estado compacto para móvil
    const mini = $("#mini-estado");
    mini.style.background = COLOR_NIVEL[a.orden];
    mini.style.color = a.tinta;
    mini.innerHTML = `${icono(a.cara, "icon")} ${esc(a.titulo)}`;
    mini.classList.add("visible");

    // 5.7 Modo técnico: las cifras reales
    const p = d.predicciones;
    $("#tec-simulador").innerHTML = `<h3>Detalle técnico</h3><div class="tec-cifras">
      <div>PM2.5 pronosticado<b>${fmt(p.pm2_5.valor, 2)} µg/m³</b>MAE prueba ${fmt(p.pm2_5.error_tipico, 2)} · rango P95 prueba ${fmt(p.pm2_5.intervalo_p95.inferior, 2)}–${fmt(p.pm2_5.intervalo_p95.superior, 2)} µg/m³</div>
      <div>PM10 pronosticado<b>${fmt(p.pm10.valor, 2)} µg/m³</b>MAE prueba ${fmt(p.pm10.error_tipico, 2)} · rango P95 prueba ${fmt(p.pm10.intervalo_p95.inferior, 2)}–${fmt(p.pm10.intervalo_p95.superior, 2)} µg/m³</div>
      <div>Cobertura de importancia<b>${fmt(d.cobertura.porcentaje, 1)} %</b>PM2.5 ${fmt(d.cobertura.por_objetivo.pm2_5, 0)} % · PM10 ${fmt(d.cobertura.por_objetivo.pm10, 0)} %</div>
      <div>Categoría ICA<b>${esc(a.categoria_ica)}</b>${esc(a.motivo)}</div></div>
      <p class="suave">Estimadas: ${d.entrada.estimadas.map((e) => `${esc(e.etiqueta)} ≈ ${fmt(e.valor, 2)}`).join(" · ") || "ninguna"} ·
      ${esc(d.tecnico.explicador[a.contaminante])} · ${fmt(d.tecnico.latencia_ms, 0)} ms</p>`;
    if (estado.benchmark && !$("#vista-modelos").hidden) pintarConfiable();
  }

  /* -----------------------------------------------------------------
     PASO 6 · ¿Por qué? — dirección y magnitud de los aportes TreeSHAP
     ----------------------------------------------------------------- */
  function tarjetaFactor(f, maxAporte) {
    const favorable = f.aporte < 0;
    const color = favorable ? "var(--aporte-favorable)" : "var(--aporte-desfavorable)";
    const ancho = Math.max(2, Math.abs(f.aporte) / maxAporte * 100);
    const d = f.valor < 5 ? 2 : 1;
    return `<button type="button" class="factor ${f.origen === "estimada" ? "factor--estimada" : ""}" style="--color:${color}"
              aria-label="${esc(f.nombre)}: ${favorable ? "aporte favorable, disminuye el valor predicho" : "aporte desfavorable, incrementa el valor predicho"} en ${fmtSigno(f.aporte, 1)} microgramos por metro cúbico. Toca para saber más.">
      <span class="factor__giro">
        <span class="factor__cara">
          <span class="factor__fila">
            <span class="factor__ico" aria-hidden="true">${icono(f.icono, "icon")}</span>
            <span class="factor__texto"><span class="factor__nombre">${esc(f.nombre)}</span><small class="factor__comun">${esc(f.nombre_comun)}</small></span>
          </span>
          <span class="aporte__valor">${fmtSigno(f.aporte, 1)} µg/m³</span>
          <span class="aporte__pista" aria-hidden="true"><span style="width:${ancho}%"></span></span>
          <span class="aporte__direccion">${favorable ? "Disminuye el índice predicho (Aporte favorable)" : "Incrementa el nivel de contaminación (Aporte desfavorable)"}</span>
          ${f.origen === "estimada" ? `<span class="factor__pista">No lo diste: lo calculamos por ti</span>` : ""}
        </span>
        <span class="factor__dorso">
          <b>${icono(f.icono, "icon")} ${esc(f.nombre)}</b>
          <small class="factor__comun">${esc(f.nombre_comun)}</small>
          <span>${esc(f.que_es)}</span>
          <span class="suave">Valor usado: ${fmt(f.valor, d)} ${esc(f.unidad === "adim." || f.unidad === "índice" ? "" : f.unidad)}</span>
          <span class="aporte__valor">${fmtSigno(f.aporte, 1)} µg/m³</span>
        </span>
      </span></button>`;
  }

  function pintarPorque() {
    const d = estado.resultado;
    $("#xai-vacio").hidden = !!d;
    $("#xai-contenido").hidden = !d;
    if (!d) return;
    const a = d.alerta, s = d.explicacion[a.contaminante].simple;

    const e = d.explicacion[a.contaminante];
    const relevantes = [...s.favorables, ...s.desfavorables];
    const maxAporte = Math.max(...relevantes.map((f) => Math.abs(f.aporte)), 0.01);
    $("#xai-frase").textContent = s.frase;
    $("#xai-resumen-base").innerHTML = `Valor base E[f(X)]: <b>${fmt(e.valor_base, 2)} µg/m³</b>
      <span aria-hidden="true">+</span> aportes TreeSHAP = valor predicho <b>${fmt(e.prediccion, 2)} µg/m³</b>`;

    $("#col-favorables").innerHTML = s.favorables.length ? s.favorables.map((f) => tarjetaFactor(f, maxAporte)).join("")
      : `<div class="columna__vacia">Sin aportes favorables relevantes</div>`;
    $("#col-desfavorables").innerHTML = s.desfavorables.length ? s.desfavorables.map((f) => tarjetaFactor(f, maxAporte)).join("")
      : `<div class="columna__vacia">Sin aportes desfavorables relevantes</div>`;
    $$(".factor").forEach((b) => b.addEventListener("click", () => b.classList.toggle("girada")));
    $("#xai-nota").textContent = "Las barras comparan la magnitud absoluta de los aportes mostrados." +
      (s.hay_estimadas ? " Las tarjetas punteadas son datos que no diste: los calculamos por ti." : "");

    // Modo técnico: SHAP por variable para PM2.5 o PM10
    $$("#xai-tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.objetivo === estado.objetivoTec)));
    const eTec = d.explicacion[estado.objetivoTec];
    const items = eTec.contribuciones.map((c) => ({
      etiqueta: c.etiqueta, valor: c.aporte,
      tooltip: [["Valor", fmt(c.valor, 3)], ["Origen", c.origen], ["Aporte", fmtSigno(c.aporte) + " µg/m³"]],
    }));
    items.push({ etiqueta: "Calendario", valor: eTec.calendario.aporte, tooltip: [["Promedio", "12 meses x 7 días"]] });
    if (document.body.classList.contains("modo-tecnico"))
      window.Graficos.barrasDivergentes($("#grafico-barras"), items);
    const v = eTec.verificacion_aditiva;
    $("#xai-ecuacion").innerHTML = `Base E[f(X)] ${fmt(eTec.valor_base, 3)} + suma de aportes ${fmtSigno(v.base_mas_aportes - eTec.valor_base, 3)}
      = <b>${fmt(v.base_mas_aportes, 3)}</b> · predicción ${fmt(v.prediccion, 3)} µg/m³ ${icono(v.ok ? "checkCircle" : "triangleAlert", "icon")} ${v.ok ? "aditividad TreeSHAP verificada" : "revisar aditividad TreeSHAP"}`;
  }
  $$("#xai-tabs button").forEach((b) => b.addEventListener("click", () => { estado.objetivoTec = b.dataset.objetivo; pintarPorque(); }));

  /* -----------------------------------------------------------------
     PASO 7 · ¿Es confiable? — tiro al blanco de métodos
     ----------------------------------------------------------------- */
  const NOMBRE_MODELO = {
    xgboost: "XGBoost", desplegado: "XGBoost", lightgbm: "LightGBM", random_forest: "Bosque aleatorio",
    persistencia: "Repetir lo de ayer", media_movil: "Promedio de 3 días", media_historica: "Promedio de siempre",
  };
  const COLOR_MODELO = {
    xgboost: "#2a78d6", desplegado: "#2a78d6", lightgbm: "#eb6834", random_forest: "#1baf7a",
    persistencia: "#6f6d68", media_movil: "#a8a69e", media_historica: "#cfcdc5",
  };

  async function cargarBenchmark() {
    if (estado.benchmark) return pintarConfiable();
    try {
      estado.benchmark = await (await fetch(CONFIG.api.benchmark, { credentials: "same-origin" })).json();
      pintarConfiable();
    } catch {
      $("#bm-contenido").innerHTML = `<div class="aviso">No se pudo cargar la comparación.</div>`;
    }
  }

  function pintarConfiable() {
    const b = estado.benchmark;
    if (!b) return;
    const clave = estado.objetivoTec;
    const calc = b.calculado && b.calculado.objetivos[clave];
    let modelos, elegido, mejora, estab = null, limite = true;

    if (calc) {
      const hayDesplegado = calc.modelos.some((m) => m.desplegado && m.id === "desplegado");
      const lista = calc.modelos.filter((m) => !(hayDesplegado && m.id === "xgboost"));
      modelos = lista.map((m) => ({
        id: m.id, nombre: NOMBRE_MODELO[m.id] || m.nombre, mae: m.prueba.mae,
        elegido: !!m.desplegado, color: COLOR_MODELO[m.id] || "#999", fila: m,
      }));
      if (!modelos.some((m) => m.elegido)) modelos.find((m) => m.id === "xgboost").elegido = true;
      elegido = modelos.find((m) => m.elegido);
      mejora = elegido.fila.mejora_vs_persistencia;
      const ensambles = lista.filter((m) => m.estabilidad && m.familia !== "Referencia ingenua")
        .sort((x, y) => x.estabilidad.desv - y.estabilidad.desv);
      if (elegido.fila.estabilidad) estab = ensambles.findIndex((m) => m.id === elegido.id) + 1;
      limite = elegido.fila.prueba.mae_criticos != null;
    } else {
      // Sin benchmark calculado: se usan los resultados oficiales de la tesis
      const t = b.tesis.prueba;
      modelos = [
        { id: "xgboost", nombre: "XGBoost", mae: t[1][clave].mae, elegido: true, color: COLOR_MODELO.xgboost },
        { id: "persistencia", nombre: "Repetir lo de ayer", mae: t[0][clave].mae, elegido: false, color: COLOR_MODELO.persistencia },
      ];
      elegido = modelos[0];
      mejora = b.tesis.mejora_vs_persistencia[clave];
    }

    const orden = [...modelos].sort((x, y) => x.mae - y.mae);
    const tecTabla = calc ? `<div class="tarjeta tec" style="margin-top:22px">
        <div class="segmentado" role="tablist" id="bm-tabs">
          <button role="tab" type="button" data-objetivo="pm2_5" aria-selected="${clave === "pm2_5"}">PM2.5</button>
          <button role="tab" type="button" data-objetivo="pm10" aria-selected="${clave === "pm10"}">PM10</button></div>
        <table class="tabla"><thead><tr><th>Modelo</th><th class="num">MAE val.</th><th class="num">R² val.</th><th class="num">Puntaje</th>
          <th class="num">MAE prueba</th><th class="num">RMSE prueba</th><th class="num">R² prueba</th><th class="num">MAE picos</th><th class="num">± bloques</th></tr></thead><tbody>
        ${calc.modelos.map((m) => `<tr class="${m.desplegado ? "destacada" : ""}"><td>${esc(m.nombre)}</td>
          <td class="num">${fmt(m.validacion.mae, 3)}</td><td class="num">${fmt(m.validacion.r2, 3)}</td>
          <td class="num">${m.ranking ? m.ranking.total : "—"}</td>
          <td class="num">${fmt(m.prueba.mae, 3)}</td><td class="num">${fmt(m.prueba.rmse, 3)}</td><td class="num">${fmt(m.prueba.r2, 3)}</td>
          <td class="num">${m.prueba.mae_criticos != null ? fmt(m.prueba.mae_criticos, 3) : "—"}</td>
          <td class="num">${m.estabilidad ? fmt(m.estabilidad.desv, 3) : "—"}</td></tr>`).join("")}
        </tbody></table>
        <p class="suave">${b.calculado.sustituto ? `${icono("triangleAlert", "icon")} Calculado con un sustituto de XGBoost (scikit-learn). ` : ""}Tesis (prueba): XGBoost MAE ${fmt(b.tesis.prueba[1][clave].mae, 3)} · R² ${fmt(b.tesis.prueba[1][clave].r2, 3)}.
        El escenario B (mismo día) logra R² ${fmt(b.tesis.prueba[2][clave].r2, 3)}, pero describe el presente; el objetivo es anticipar.</p></div>` : "";

    const d = estado.resultado;
    const resumenActual = d ? (() => {
      const comp = d.entrada.completitud;
      const imputadas = d.entrada.estimadas.length;
      const metodoImputacion = d.tecnico.imputacion === "iterativa"
        ? "imputación iterativa ajustada con datos de entrenamiento"
        : "mediana histórica calculada con datos de entrenamiento";
      const prediccion = (etiqueta, p) => `<div class="incertidumbre__prediccion">
        <b>${etiqueta}: ${fmt(p.valor, 2)} µg/m³</b>
        <span>Rango predictivo empírico P95: ${fmt(p.intervalo_p95.inferior, 2)}–${fmt(p.intervalo_p95.superior, 2)} µg/m³</span>
      </div>`;
      return `<section class="tarjeta resumen-fiabilidad" aria-labelledby="resumen-fiabilidad-titulo">
        <h2 id="resumen-fiabilidad-titulo">Predicción y calidad de los datos</h2>
        <div class="incertidumbre__predicciones">
          ${prediccion("PM₂.₅", d.predicciones.pm2_5)}${prediccion("PM₁₀", d.predicciones.pm10)}
        </div>
        <div class="completitud">
          <div class="completitud__valor">Completitud de datos: <b>${comp.ingresadas} de ${comp.total} variables (${fmt(comp.porcentaje, 0)} %)</b></div>
          <div class="completitud__barra" role="meter" aria-label="Completitud de datos" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${comp.porcentaje}">
            <span style="width:${comp.porcentaje}%"></span></div>
        </div>
        <p class="suave">${imputadas
          ? `${imputadas} ${imputadas === 1 ? "variable imputada" : "variables imputadas"} mediante ${metodoImputacion}.`
          : "No se imputaron variables: todos los datos disponibles fueron ingresados."}</p>
        <p class="suave">El rango P95 se estima con errores absolutos del conjunto de prueba cronológico reservado. Es orientativo: no es un intervalo de confianza garantizado y el error puede variar con el tiempo y las condiciones.</p>
      </section>`;
    })() : `<section class="tarjeta resumen-fiabilidad"><h2>Predicción y calidad de los datos</h2>
      <p class="suave">Ingresa datos en el simulador para ver la predicción, su rango empírico y la completitud.</p></section>`;

    $("#bm-contenido").innerHTML = `${resumenActual}
      <div class="rejilla-conf">
        <div class="tarjeta diana" id="diana"></div>
        <div>
          <p class="frase-grande">${icono("target", "icon")} Elegimos <b>${esc(elegido.nombre)}</b> porque es el que menos se equivoca.</p>
          <p class="suave">Cada dardo es una forma distinta de adivinar el aire de mañana. El centro es el acierto perfecto: entre más cerca, mejor adivina.</p>
          <ol class="podio-lista">${orden.map((m, i) => `<li class="${m.elegido ? "elegido" : ""}">
            <span class="medalla" aria-label="Puesto ${i + 1}">${i + 1}</span>${esc(m.nombre)}${m.elegido ? ` ${icono("star", "icon")}` : ""}
            <span class="pin" style="background:${m.color}" aria-hidden="true"></span></li>`).join("")}</ol>
        </div>
      </div>
      <div class="insignias">
        <div class="insignia"><span class="insignia__ico">${icono("target", "icon")}</span><b>Más certero</b>
          <span>Falla ${fmt(mejora, 0)} % menos que «repetir lo de ayer».</span></div>
        <div class="insignia"><span class="insignia__ico">${icono("ruler", "icon")}</span><b>Constante</b>
          <span>${estab === 1 ? "Es el más parejo en las distintas épocas del año." : "Lo probamos en varias épocas del año y se mantuvo."}</span></div>
        <div class="insignia"><span class="insignia__ico">${icono("bolt", "icon")}</span><b>Rápido y transparente</b>
          <span>Responde al instante y te dice por qué.</span></div>
        ${limite ? `<div class="insignia insignia--limite"><span class="insignia__ico">${icono("triangleAlert", "icon")}</span><b>Su límite</b>
          <span>Le cuesta anticipar los días más contaminados.</span></div>` : ""}
      </div>${tecTabla}`;

    window.Graficos.diana($("#diana"), modelos);
    $$("#bm-tabs button").forEach((bt) => bt.addEventListener("click", () => { estado.objetivoTec = bt.dataset.objetivo; pintarConfiable(); }));
  }

  /* -----------------------------------------------------------------
     PASO 8 · Arranque
     ----------------------------------------------------------------- */
  function repintarTodo() {
    if (estado.resultado) { pintarResultado(estado.resultado); pintarPorque(); }
    if (estado.benchmark && !$("#vista-modelos").hidden) pintarConfiable();
  }
  const pie = $("#estado-modelo");
  $(".punto", pie).classList.add(CONFIG.listo ? "ok" : "error");
  $("#mini-estado").addEventListener("click", () => $(".escena-tarjeta").scrollIntoView({ behavior: "smooth", block: "center" }));
  $(".nav-item__txt", pie).textContent = CONFIG.listo ? "Modelo listo" : "Modelo no disponible";
  if (!CONFIG.listo) mostrarAviso("La interfaz está disponible, pero las predicciones no. " + (CONFIG.error_carga || ""));
  poblarSelector();
  mostrarVista();
})();
