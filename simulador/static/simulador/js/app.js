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
    fichaModelo: null,
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
               aria-describedby="dato-error-${id}" value="${fmt(inicial, d).replace(/\./g, "")}" autocomplete="off">
        <small class="dato__error" id="dato-error-${id}" role="alert" hidden></small>
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
      const error = x === null || !Number.isFinite(x)
        ? "Escribe un número válido."
        : x < v.min_valido || x > v.max_valido
          ? `El valor debe estar entre ${fmt(v.min_valido, d)} y ${fmt(v.max_valido, d)} ${v.unidad}.`
          : "";
      const malo = Boolean(error);
      num.toggleAttribute("aria-invalid", malo);
      num.style.borderColor = malo ? "var(--n3)" : "";
      const errorEl = $(`#dato-error-${id}`, li);
      errorEl.textContent = error;
      errorEl.hidden = !malo;
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
      const meta = PORID[id];
      const x = aNumero($(".dato__num", li).value);
      if (x === null || !Number.isFinite(x) || x < meta.min_valido || x > meta.max_valido) return null;
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

    // 5.1 El fondo y la lectura principal cambian según el nivel pronosticado
    if (!estado.escena) estado.escena = window.Graficos.escena($("#escena"));
    estado.escena.actualizar(a.orden);
    const ver = $("#veredicto");
    const clave = a.titulo + a.cara;
    const pronostico = d.predicciones[a.contaminante];
    const etiquetaPronostico = a.contaminante === "pm2_5" ? "PM₂.₅" : "PM₁₀";
    const detalleNivel = [
      "Nivel estimado dentro de los límites saludables",
      "Nivel aceptable para la mayoría de las personas",
      "Puede afectar a personas sensibles",
      "Puede afectar la salud de toda la población",
      "Nivel muy perjudicial para la salud",
    ][a.orden];
    if (ver.dataset.clave !== clave) { // solo «rebota» la cara si cambió el nivel
      ver.dataset.clave = clave;
      ver.innerHTML = `<span class="veredicto__estado">
          <span class="veredicto__cara" style="color:${COLOR_NIVEL[a.orden]}" aria-hidden="true">${icono(a.cara, "icon")}</span>
          <span class="veredicto__titulo">${esc(a.titulo)}</span>
        </span>
        <span class="veredicto__medicion">
          <span class="veredicto__etiqueta">${etiquetaPronostico} estimado para mañana</span>
          <strong class="veredicto__valor"><span class="veredicto__numero">${fmt(pronostico.valor, 1)}</span> <span>µg/m³</span></strong>
        </span>
        <span class="veredicto__frase">${detalleNivel}. ${esc(a.frase)}</span>`;
    }
    ver.querySelector(".veredicto__etiqueta").textContent = `${etiquetaPronostico} estimado para mañana`;
    ver.querySelector(".veredicto__numero").textContent = fmt(pronostico.valor, 1);

    // 5.2 Barra de cinco estados con el nivel pronosticado destacado
    const nivelActual = ["Limpio", "Aceptable", "Regular", "Contaminado", "Peligroso"][a.orden];
    $("#escala").innerHTML = `
      <div class="escala__pista" role="img" aria-label="Nivel pronosticado: ${nivelActual}">
        ${CARAS.map((_, i) => `<span class="escala__tramo ${i === a.orden ? "activo" : ""}" style="--nivel-color:${COLOR_NIVEL[i]}"></span>`).join("")}
        <span class="escala__indicador" style="--nivel-color:${COLOR_NIVEL[a.orden]};--posicion:${(a.orden + 0.5) * 20}%" aria-hidden="true"></span>
      </div>
      <div class="escala__etiquetas" aria-hidden="true">
        ${["Limpio", "Aceptable", "Regular", "Contaminado", "Peligroso"].map((txt, i) => `<span class="escala__etiqueta ${i === a.orden ? "activo" : ""}">${txt}</span>`).join("")}
      </div>`;

    $("#alerta-local").hidden = !a.dia_critico_local;
    $("#alerta-local").innerHTML = `${icono("triangleAlert", "icon")} Mañana el aire estaría más sucio que en 9 de cada 10 días de la ciudad.`;

    // 5.3 Completitud observada + sugerencia del dato más útil que falta
    const faltante = CATALOGO.find((v) => !estado.filas.has(v.id));
    const completas = d.entrada.completitud;
    $("#precision").innerHTML = `<h3>Datos ingresados</h3>
      <div class="completitud__valor">${completas.ingresadas} de ${completas.total} datos ingresados <b>(${fmt(completas.porcentaje, 0)} %)</b></div>
      <div class="completitud__barra" role="meter" aria-label="Completitud de datos" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${completas.porcentaje}">
        <span style="width:${completas.porcentaje}%"></span></div>
      ${faltante && completas.ingresadas < completas.total ? `<button type="button" class="sugerencia" data-id="${faltante.id}">${icono("plus", "icon")} ${icono(faltante.simple_icono, "icon")} Agregar ${esc(faltante.etiqueta)} — ${esc(faltante.nombre_largo)}</button>` : ""}`;
    const sug = $(".sugerencia", $("#precision"));
    if (sug) sug.addEventListener("click", () => agregarVariable(sug.dataset.id));

    // 5.4 Resumen breve de las atribuciones TreeSHAP
    const s = d.explicacion[a.contaminante].simple;
    const fila = (f, favorable) => f ? `<div class="porque-mini__fila ${favorable ? "porque-mini__fila--favorable" : "porque-mini__fila--desfavorable"}">
        <span><strong>${esc(f.nombre)}</strong><small class="factor__comun">${favorable ? "🟢 Ayuda a mantener el aire limpio" : "🔴 Puede empeorar la calidad del aire"}</small></span></div>` : "";
    $("#porque-mini").innerHTML = `<h3>¿Por qué?</h3>${fila(s.desfavorables[0], false)}${fila(s.favorables[0], true)}
      ${!s.desfavorables.length && !s.favorables.length ? `<p class="suave">No hay aportes individuales relevantes.</p>` : ""}
      <span class="ver-mas">Ver la explicación ${icono("arrowRight", "icon")}</span>`;

    // 5.5 Consejos para hoy (máximo seis palabras cada uno)
    const ESTADO_RECOMENDACION = { si: "Recomendado", precaucion: "Con cuidado", no: "Mejor evitar" };
    $("#recomendaciones").innerHTML = d.recomendaciones.map((r) => `
      <button type="button" class="rec rec--${r.estado}"
              aria-label="${esc(r.etiqueta)}. ${ESTADO_RECOMENDACION[r.estado]}. Pulsa para ver el motivo."
              data-etiqueta="${esc(r.etiqueta)}" data-estado="${ESTADO_RECOMENDACION[r.estado]}"
              data-motivo="${esc(r.texto)}"
              aria-expanded="false">
        <span class="rec__giro">
          <span class="rec__cara">
            <span class="rec__ico" aria-hidden="true">${icono(r.icono, "icon")}</span>
            <span class="rec__tit">${esc(r.etiqueta)}</span>
            <span class="rec__txt"><span class="rec__estado">${ESTADO_RECOMENDACION[r.estado]}</span></span>
          </span>
          <span class="rec__dorso">
            <span class="rec__motivo-titulo">¿Por qué?</span>
            <span class="rec__motivo">${esc(r.texto)}</span>
            <span class="rec__volver">Toca para volver</span>
          </span>
        </span>
      </button>`).join("");
    $$(".rec", $("#recomendaciones")).forEach((tarjeta) => {
      tarjeta.addEventListener("click", () => {
        const girada = tarjeta.classList.toggle("girada");
        tarjeta.setAttribute("aria-expanded", String(girada));
        tarjeta.setAttribute("aria-label", girada
          ? `Motivo de ${tarjeta.dataset.etiqueta}: ${tarjeta.dataset.motivo}. Pulsa para volver a la recomendación.`
          : `${tarjeta.dataset.etiqueta}. ${tarjeta.dataset.estado}. Pulsa para ver el motivo.`);
      });
    });

    // 5.6 Estado compacto para móvil
    const mini = $("#mini-estado");
    mini.style.background = COLOR_NIVEL[a.orden];
    mini.style.color = a.tinta;
    mini.innerHTML = `${icono(a.cara, "icon")} ${esc(a.titulo)}`;
    mini.classList.add("visible");

    // 5.7 Modo técnico: las cifras reales
    const p = d.predicciones;
    const exp = d.explicacion[a.contaminante];
    const objetivo = a.contaminante === "pm2_5" ? "PM₂.₅" : "PM₁₀";
    const margen = p[a.contaminante];
    $("#tec-simulador").innerHTML = `
      <header class="tec-simulador__cabecera">
        <div>
          <h3>Inspección técnica y diagnóstico del modelo</h3>
          <p>Detalle del pronóstico de ${objetivo} para mañana.</p>
        </div>
        <span class="tec-simulador__chip">Vista técnica</span>
      </header>
      <div class="tec-kpis">
        <article class="tec-kpi">
          <span class="tec-kpi__etiqueta">Métrica base · E[f(x)]</span>
          <strong>${fmt(exp.valor_base, 2)} µg/m³</strong>
          <span>Valor esperado global del modelo</span>
        </article>
        <article class="tec-kpi">
          <span class="tec-kpi__etiqueta">Margen de error</span>
          <strong>± ${fmt(margen.margen_p95, 2)} µg/m³</strong>
          <span>Rango P95: ${fmt(margen.intervalo_p95.inferior, 2)}–${fmt(margen.intervalo_p95.superior, 2)} µg/m³ · MAE ${fmt(margen.error_tipico, 2)}</span>
        </article>
        <article class="tec-kpi">
          <span class="tec-kpi__etiqueta">Cobertura del modelo</span>
          <strong>${fmt(d.cobertura.por_objetivo[a.contaminante], 1)} %</strong>
          <span>Importancia cubierta por los datos ingresados</span>
        </article>
        <article class="tec-kpi">
          <span class="tec-kpi__etiqueta">Firma del modelo</span>
          <strong>${esc(d.tecnico.algoritmo[a.contaminante])}</strong>
          <span>${esc(d.tecnico.explicador[a.contaminante])}</span>
        </article>
      </div>
      <div class="tec-simulador__detalle">
        <span><b>PM₂.₅:</b> ${fmt(p.pm2_5.valor, 2)} µg/m³</span>
        <span><b>PM₁₀:</b> ${fmt(p.pm10.valor, 2)} µg/m³</span>
        <span><b>Categoría ICA:</b> ${esc(a.categoria_ica)}</span>
        <span><b>Imputación:</b> ${esc(d.tecnico.imputacion)}</span>
        <span><b>Latencia:</b> ${fmt(d.tecnico.latencia_ms, 0)} ms</span>
      </div>
      <p class="tec-simulador__estimadas">Variables estimadas: ${d.entrada.estimadas.map((e) => `${esc(e.etiqueta)} ≈ ${fmt(e.valor, 2)} ${esc(e.unidad)}`).join(" · ") || "ninguna"}</p>`;
    if (estado.benchmark && !$("#vista-modelos").hidden) pintarConfiable();
  }

  /* -----------------------------------------------------------------
     PASO 6 · ¿Por qué? — factores explicados en lenguaje cotidiano
     ----------------------------------------------------------------- */
  function tarjetaFactor(f, maxAporte, favorable) {
    const ancho = Math.max(2, Math.abs(f.aporte) / maxAporte * 100);
    const unidad = f.unidad === "adim." || f.unidad === "índice" ? "" : ` ${esc(f.unidad)}`;
    const decimalesValor = f.valor < 5 ? 2 : 1;
    const direccion = favorable ? "ayuda a limpiar el aire" : "aumenta la contaminación";
    return `<article class="factor ${favorable ? "factor--favorable" : "factor--desfavorable"} ${f.origen === "estimada" ? "factor--estimada" : ""}"
              aria-label="${esc(f.nombre_comun)} (${esc(f.etiqueta)}): ${fmt(f.valor, decimalesValor)}${unidad}, ${direccion}.">
      <span class="factor__ico" aria-hidden="true">${icono(f.icono, "icon")}</span>
      <span class="factor__nombre">${esc(f.nombre_comun)}</span>
      <span class="factor__variable">${esc(f.etiqueta)}</span>
      <span class="factor__valor-etiqueta">${f.origen === "estimada" ? "Valor estimado" : "Valor medido"}</span>
      <strong class="factor__valor">${fmt(f.valor, decimalesValor)}${unidad}</strong>
      <span class="aporte__pista" role="img" aria-label="Nivel de influencia: ${direccion}">
        <span style="width:${ancho}%"></span>
      </span>
      ${f.origen === "estimada" ? `<span class="factor__estimada">Estimado automáticamente</span>` : "" }
    </article>`;
  }

  function pintarPorque() {
    const d = estado.resultado;
    $("#xai-vacio").hidden = !!d;
    $("#xai-contenido").hidden = !d;
    if (!d) return;
    const a = d.alerta, e = d.explicacion[a.contaminante], s = e.simple;
    const relevantes = [...s.favorables, ...s.desfavorables];
    const maxAporte = Math.max(...relevantes.map((f) => Math.abs(f.aporte)), 0.01);
    const objetivo = a.contaminante === "pm2_5" ? "PM₂.₅" : "PM₁₀";
    const saludables = a.orden === 0;
    const factoresClave = (a.orden < 2 ? s.favorables : s.desfavorables)
      .slice(0, 2)
      .map((f) => f.nombre_comun);
    const influencia = factoresClave.length
      ? `${a.orden < 2 ? "Ayudan especialmente" : "Influyen especialmente"} ${factoresClave.join(" y ")}.`
      : "El resultado combina los datos ingresados y los estimados automáticamente.";
    const estadoHumano = saludables
      ? "se mantiene en niveles saludables"
      : a.orden === 1
        ? "se mantiene en un nivel aceptable para la mayoría"
        : a.orden === 2
          ? "requiere precaución para las personas sensibles"
          : "puede afectar la salud; conviene limitar las actividades al aire libre";
    $("#xai-frase").textContent = `El pronóstico de ${objetivo} (${fmt(e.prediccion, 1)} µg/m³) ${estadoHumano}. ${influencia}`;
    $("#xai-resumen-base").innerHTML = `Valor base E[f(X)]: <b>${fmt(e.valor_base, 2)} µg/m³</b>
      <span aria-hidden="true">+</span> aportes TreeSHAP = valor predicho <b>${fmt(e.prediccion, 2)} µg/m³</b>`;

    $("#col-favorables").innerHTML = s.favorables.length ? s.favorables.map((f) => tarjetaFactor(f, maxAporte, true)).join("")
      : `<div class="columna__vacia">Sin aportes favorables relevantes</div>`;
    $("#col-desfavorables").innerHTML = s.desfavorables.length ? s.desfavorables.map((f) => tarjetaFactor(f, maxAporte, false)).join("")
      : `<div class="columna__vacia">Sin aportes desfavorables relevantes</div>`;
    $("#xai-nota").textContent = s.hay_estimadas
      ? "Los datos con la etiqueta «Estimado automáticamente» se completaron porque no fueron ingresados."
      : "";

    // Modo técnico: SHAP por variable para PM2.5 o PM10
    $$("#xai-tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.objetivo === estado.objetivoTec)));
    const eTec = d.explicacion[estado.objetivoTec];
    const items = eTec.detalle.map((c) => ({
      columna: c.columna, aporte: c.aporte, origen: c.origen,
    }));
    if (document.body.classList.contains("modo-tecnico"))
      window.Graficos.cascadaSHAP($("#grafico-cascada"), eTec.valor_base, eTec.prediccion, items);
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

  async function abrirFichaModelo() {
    const dialogo = $("#ficha-modelo");
    const contenido = $("#ficha-modelo-contenido");
    dialogo.showModal();
    $("#estado-modelo").setAttribute("aria-expanded", "true");
    contenido.innerHTML = `<p class="suave">Cargando ficha técnica…</p>`;
    try {
      if (!estado.fichaModelo) {
        const respuesta = await fetch(CONFIG.api.estado, { credentials: "same-origin" });
        if (!respuesta.ok) throw new Error(`El servidor respondió ${respuesta.status}.`);
        estado.fichaModelo = await respuesta.json();
        if (!estado.fichaModelo.ok) throw new Error("No se pudo obtener el estado de los modelos.");
      }
      const datos = estado.fichaModelo;
      const nombreAlgoritmo = {
        XGBRegressor: "XGBoost Regressor",
        GradientBoostingRegressor: "Gradient Boosting Regressor",
        RandomForestRegressor: "Random Forest Regressor",
        LGBMRegressor: "LightGBM Regressor",
      };
      contenido.innerHTML = datos.listo
        ? `<div class="ficha-modelo__rejilla">${Object.entries(datos.modelos).map(([clave, modelo]) => {
          const metrica = modelo.metricas_validacion;
          return `<article class="ficha-modelo__objetivo">
            <h3>${clave === "pm2_5" ? "PM₂.₅" : "PM₁₀"}</h3>
            <p><b>Algoritmo:</b> ${esc(nombreAlgoritmo[modelo.tipo] || modelo.tipo)}</p>
            <p><b>Validación cronológica (n = ${metrica.muestras}):</b></p>
            <ul>
              <li>R² = ${fmt(metrica.r2, 3)}</li>
              <li>RMSE = ${fmt(metrica.rmse, 2)} µg/m³</li>
              <li>MAE = ${fmt(metrica.mae, 2)} µg/m³</li>
            </ul>
          </article>`;
        }).join("")}</div>`
        : `<p class="aviso">${esc(datos.error || "Los modelos no están disponibles.")}</p>`;
    } catch (error) {
      contenido.innerHTML = `<p class="aviso">No se pudo cargar la ficha técnica. ${esc(error.message)}</p>`;
    }
  }
  $("#cerrar-ficha-modelo").addEventListener("click", () => $("#ficha-modelo").close());
  $("#ficha-modelo").addEventListener("close", () => $("#estado-modelo").setAttribute("aria-expanded", "false"));

  async function cargarBenchmark() {
    if (estado.benchmark) return pintarConfiable();
    try {
      const respuesta = await fetch(CONFIG.api.benchmark, { credentials: "same-origin" });
      if (!respuesta.ok) throw new Error(`El servidor respondió ${respuesta.status}.`);
      const datos = await respuesta.json();
      if (!datos.ok) throw new Error(datos.error || "La respuesta del servidor no contiene el benchmark.");
      estado.benchmark = datos;
      pintarConfiable();
    } catch (error) {
      console.error("No se pudo cargar la vista de precisión del modelo.", error);
      $("#bm-contenido").innerHTML = `<div class="aviso" role="alert">No se pudo cargar la precisión del modelo. ${esc(error.message || "Comprueba la conexión e inténtalo de nuevo.")}</div>`;
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
    const tecTabla = calc ? `<div class="validacion-formal__comparacion">
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

    const metricasValidacion = b.metricas_validacion || {};
    const matricesConfusion = Object.entries(metricasValidacion).map(([id, m]) => {
      const etiquetas = m.etiquetas_categoria;
      return `<article class="matriz-confusion">
        <h4>${id === "pm2_5" ? "PM₂.₅" : "PM₁₀"} · validación (n = ${m.muestras})</h4>
        <p>MAE ${fmt(m.mae, 2)} µg/m³ · RMSE ${fmt(m.rmse, 2)} µg/m³ · R² ${fmt(m.r2, 3)} · acierto de categoría ${fmt(m.exactitud_categoria_pct, 1)} %</p>
        <div class="matriz-confusion__scroll">
          <table class="tabla matriz-confusion__tabla">
            <caption>Filas: categoría observada. Columnas: categoría predicha.</caption>
            <thead><tr><th>Observada ↓ / Predicha →</th>${etiquetas.map((e) => `<th>${esc(e)}</th>`).join("")}</tr></thead>
            <tbody>${m.matriz_confusion.map((fila, i) => `<tr><th scope="row">${esc(etiquetas[i])}</th>${fila.map((valor, j) => `<td class="num ${i === j ? "destacada" : ""}">${valor}</td>`).join("")}</tr>`).join("")}</tbody>
          </table>
        </div>
      </article>`;
    }).join("");

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
      return `<section class="tarjeta resumen-fiabilidad tec" aria-labelledby="resumen-fiabilidad-titulo">
        <h2 id="resumen-fiabilidad-titulo">Predicción y calidad de los datos</h2>
        <div class="incertidumbre__predicciones">
          ${prediccion("PM₂.₅", d.predicciones.pm2_5)}${prediccion("PM₁₀", d.predicciones.pm10)}
        </div>
        <div class="incertidumbre__metricas">
          ${Object.entries(d.predicciones).map(([id, p]) => {
            const m = b.metricas_validacion[id];
            return `<div><b>${id === "pm2_5" ? "PM₂.₅" : "PM₁₀"}</b>
              <span>Validación: MAE ${fmt(m.mae, 2)} · RMSE ${fmt(m.rmse, 2)} µg/m³ · R² ${fmt(m.r2, 3)}</span>
              <span>Prueba: MAE ${fmt(p.error_tipico, 2)} · RMSE ${fmt(p.rmse_prueba, 2)} µg/m³</span>
            </div>`;
          }).join("")}
        </div>
        <div class="completitud">
          <div class="completitud__valor">Completitud de datos: <b>${comp.ingresadas} de ${comp.total} variables (${fmt(comp.porcentaje, 0)} %)</b></div>
          <div class="completitud__barra" role="meter" aria-label="Completitud de datos" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${comp.porcentaje}">
            <span style="width:${comp.porcentaje}%"></span></div>
        </div>
        <p class="suave">${imputadas
          ? `${imputadas} ${imputadas === 1 ? "variable imputada" : "variables imputadas"} mediante ${metodoImputacion}.`
          : "No se imputaron variables: todos los datos disponibles fueron ingresados."}</p>
        <p class="suave">Rango predictivo empírico nominal P95, calibrado con errores absolutos de validación cronológica. No es un intervalo de confianza de parámetros ni una cobertura garantizada; los errores pueden cambiar con el tiempo y las condiciones.</p>
      </section>`;
    })() : `<section class="tarjeta resumen-fiabilidad"><h2>Predicción y calidad de los datos</h2>
      <p class="suave">Ingresa datos en el simulador para ver la predicción, su rango empírico y la completitud.</p></section>`;

    const maeValidacion = Object.values(metricasValidacion).map((m) => m.mae);
    const precisionCategoria = b.exactitud_categoria_pct;
    const tasaAcierto = Number.isFinite(precisionCategoria)
      ? `<strong>${fmt(precisionCategoria, 0)} %</strong><span>En ${fmt(precisionCategoria, 0)} % de los días de validación, acertó las categorías de PM₂.₅ y PM₁₀.</span>`
      : `<strong>No disponible</strong><span>Se requiere el modelo y su conjunto de validación para calcular el acierto.</span>`;
    const rangoError = maeValidacion.length
      ? `<strong>${fmt(Math.min(...maeValidacion), 1)}–${fmt(Math.max(...maeValidacion), 1)} µg/m³</strong><span>Diferencia absoluta promedio frente a los valores observados en validación.</span>`
      : `<strong>No disponible</strong><span>No hay métricas de error disponibles.</span>`;
    const periodo = b.periodo_datos;
    const aniosHistoricos = periodo ? periodo.dias / 365.2425 : null;
    const datosHistoricos = periodo
      ? `<strong>${fmt(aniosHistoricos, 1)} años</strong><span>Registros diarios Open-Meteo / CAMS · ${esc(periodo.inicio)} a ${esc(periodo.fin)}.</span>`
      : `<strong>No disponible</strong><span>No se encontró el periodo del conjunto histórico.</span>`;
    const resumenPublico = `<section class="validacion-resumen" aria-label="Resumen de la validación">
      <article class="validacion-kpi">
        <span class="validacion-kpi__icono">${icono("target", "icon")}</span>
        <h2>Nivel de acierto general</h2>
        ${tasaAcierto}
      </article>
      <article class="validacion-kpi">
        <span class="validacion-kpi__icono">${icono("ruler", "icon")}</span>
        <h2>Margen de variación típico</h2>
        ${rangoError}
      </article>
      <article class="validacion-kpi">
        <span class="validacion-kpi__icono">${icono("air", "icon")}</span>
        <h2>Base de aprendizaje</h2>
        ${datosHistoricos}
        <small>Registros de Open-Meteo/CAMS; no son lecturas en tiempo real de estaciones oficiales.</small>
      </article>
    </section>
    <section class="validacion-limites" aria-label="Alcance y límites del modelo">
      <article><h2>✓ Dónde funciona mejor</h2><p>En días normales y con condiciones climáticas habituales, similares a los registros usados para validarlo.</p></article>
      <article><h2>! Casos especiales</h2><p>Ante eventos atípicos, como pólvora en fechas festivas o incendios forestales, consulta las alertas y fuentes de emergencia locales.</p></article>
    </section>`;
    const formal = `<section class="tarjeta tec validacion-formal" aria-labelledby="validacion-formal-titulo">
      <h2 id="validacion-formal-titulo">Métricas formales de validación estadística</h2>
      <p class="suave">Evaluación cronológica independiente del entrenamiento.</p>
      <div class="validacion-formal__muestras">
        <span>Entrenamiento: <b>${b.particion.entrenamiento}</b></span>
        <span>Validación: <b>${b.particion.validacion}</b></span>
        <span>Prueba: <b>${b.particion.prueba}</b></span>
      </div>
      <div class="matrices-confusion">${matricesConfusion || `<p class="suave">Métricas no disponibles.</p>`}</div>
      ${tecTabla}
    </section>`;

    $("#bm-contenido").innerHTML = `${resumenPublico}${resumenActual}
      <div class="rejilla-conf">
        <div class="tarjeta diana diana--compacta" id="diana"></div>
        <div class="conf-explicacion">
          <p class="frase-grande">${icono("target", "icon")} Elegimos <b>${esc(elegido.nombre)}</b> porque es el que menos se equivoca.</p>
          <p class="suave">Cada dardo es una forma distinta de adivinar el aire de mañana. El centro es el acierto perfecto: entre más cerca, mejor adivina.</p>
          <ol class="podio-lista">${orden.map((m, i) => `<li class="${m.elegido ? "elegido" : ""}">
            <span class="medalla" aria-label="Puesto ${i + 1}">${i + 1}</span>${esc(m.nombre)}${m.elegido ? ` ${icono("star", "icon")}` : ""}
            <span class="pin" style="background:${m.color}" aria-hidden="true"></span></li>`).join("")}</ol>
          <div class="insignias">
            <div class="insignia"><span class="insignia__ico">${icono("target", "icon")}</span><b>Más certero</b>
              <span>Falla ${fmt(mejora, 0)} % menos que «repetir lo de ayer».</span></div>
            <div class="insignia"><span class="insignia__ico">${icono("ruler", "icon")}</span><b>Constante</b>
              <span>${estab === 1 ? "Es el más parejo en las distintas épocas del año." : "Lo probamos en varias épocas del año y se mantuvo."}</span></div>
            <div class="insignia"><span class="insignia__ico">${icono("bolt", "icon")}</span><b>Rápido y transparente</b>
              <span>Responde al instante y te dice por qué.</span></div>
            ${limite ? `<div class="insignia insignia--limite"><span class="insignia__ico">${icono("triangleAlert", "icon")}</span><b>Su límite</b>
              <span>Le cuesta anticipar los días más contaminados.</span></div>` : ""}
          </div>
        </div>
      </div>
      ${formal}`;

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
  pie.addEventListener("click", abrirFichaModelo);
  $("#mini-estado").addEventListener("click", () => $(".escena-tarjeta").scrollIntoView({ behavior: "smooth", block: "center" }));
  $(".nav-item__txt", pie).textContent = CONFIG.listo ? "Modelo listo" : "Modelo no disponible";
  if (!CONFIG.listo) mostrarAviso("La interfaz está disponible, pero las predicciones no. " + (CONFIG.error_carga || ""));
  poblarSelector();
  mostrarVista();
})();
