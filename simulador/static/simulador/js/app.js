/* =====================================================================
   app.js · Interfaz de Aire Claro para público general
   ---------------------------------------------------------------------
   Recorrido de los datos (detalle en DOCUMENTACION_FLUJO_DE_DATOS.md):

     1. Django incrusta el catálogo de variables en la página (json_script).
     2. El usuario agrega datos e introduce sus valores.
     3. Los controles actualizan sus lecturas, pero no recalculan el pronóstico.
     4. Al pulsar «Predecir», calcular() envía los pares [variable : valor].
     5. El servidor imputa lo que falta, predice y calcula SHAP.
     6. Se repinta: pronóstico, escala, recomendaciones y factores
        explicados en lenguaje cotidiano.

   Regla de diseño: el público ve estados, iconos y frases cortas.
   ===================================================================== */
(function () {
  "use strict";

  /* -----------------------------------------------------------------
     PASO 0 · Utilidades
     ----------------------------------------------------------------- */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const { fmt } = window.Graficos;
  const icono = window.Iconos.svg;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // "12,5" o "12.5" se convierte a 12.5; "" se convierte a null; texto a NaN.
  function aNumero(txt) {
    const s = String(txt ?? "").trim().replace(/\s/g, "");
    if (s === "") return null;
    const n = s.includes(",") && s.includes(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(",", ".");
    return /^-?\d*\.?\d+$/.test(n) ? Number(n) : NaN;
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

  const estado = {
    filas: new Map(),      // id de variable a <li>
    resultado: null,       // última respuesta del servidor
    peticion: null,        // AbortController de la petición en curso
    cambiosPendientes: false,
    escena: null,
  };
  const NIVELES = ["Limpio", "Aceptable", "Regular", "Contaminado", "Peligroso"];
  const TITULOS_NIVEL = ["Aire limpio", "Aire aceptable", "Aire regular", "Aire contaminado", "Aire peligroso"];
  const ILUSTRACIONES = {
    cielo: `<svg viewBox="0 0 160 110" focusable="false"><g fill="none" stroke="#f4b83f" stroke-width="4" stroke-linecap="round"><path d="M112 7v8M88 17l5 7m38-7-5 7M79 35h8m50 0h8"/></g><circle cx="112" cy="36" r="20" fill="#ffc94f" stroke="#f4b83f" stroke-width="3"/><path d="M31 83c-14 0-23-8-23-20 0-11 9-20 21-20 5-15 19-24 34-21 11 2 20 9 23 19 16-3 30 9 30 24 0 11-9 18-22 18Z" fill="#fff" stroke="#4987bf" stroke-width="4" stroke-linejoin="round"/></svg>`,
    deporte: `<div class="w-16 h-16 mx-auto my-2 flex items-center justify-center">
    <svg viewBox="0 0 100 100" class="w-10 h-10" fill="none" stroke="#359ea5" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
      <!-- Cabeza -->
      <circle cx="58" cy="22" r="7" />
      <!-- Viento / Brisa detrás -->
      <path d="M22 45H32M18 53H36M24 61H30" stroke="#82d0c8" stroke-width="4" />
      <!-- Brazo trasero flexionado -->
      <path d="M48 38L38 42L36 52" />
      <!-- Torso inclinado hacia adelante -->
      <path d="M54 30L46 54" stroke-width="7" />
      <!-- Brazo delantero flexionado hacia arriba -->
      <path d="M52 35L64 42L72 37" />
      <!-- Pierna trasera en extensión completa -->
      <path d="M46 54L34 66L23 62" />
      <!-- Pierna delantera en zancada -->
      <path d="M46 54L59 66L53 82" />
    </svg>
  </div>`,
    sensibles: `<div class="w-16 h-16 mx-auto my-2 flex items-center justify-center">
    <svg viewBox="0 0 100 100" class="w-10 h-10" fill="none" stroke="#8c62c2" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
      <!-- Corazón en tono coral suave -->
      <path d="M50 78C50 78 20 60 20 38C20 26 29 18 40 18C46 18 50 22 50 22C50 22 54 18 60 18C71 18 80 26 80 38C80 60 50 78 50 78Z" />
      <!-- Hoja / Brote de aire puro en el centro -->
      <path d="M50 56V40M50 46C44 44 42 38 44 34C48 34 50 38 50 46ZM50 42C56 40 58 34 56 30C52 30 50 34 50 42Z" stroke-width="4" />
    </svg>
  </div>`,

  hogar: `<div class="w-16 h-16 mx-auto my-2 flex items-center justify-center">
    <svg viewBox="0 0 100 100" class="w-10 h-10" fill="none" stroke="#4c8db8" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
      <!-- Marco de la ventana -->
      <rect x="25" y="20" width="50" height="60" rx="4" />
      <!-- Divisiones de la ventana (cruz) -->
      <line x1="50" y1="20" x2="50" y2="80" />
      <line x1="25" y1="50" x2="75" y2="50" />
      <!-- Brisas de viento exterior -->
      <path d="M15 35c5-2 10 0 10 0M12 45c5-2 8 0 8 0" stroke="#82b8dc" stroke-width="4" />
    </svg>
  </div>`,
 };
  const ACCIONES = [
    { id: "running", titulo: "Deporte", ilustracion: "deporte", estados: { si: "Muy recomendado", precaucion: "Con moderación", no: "Mejor evitar" }, textos: { si: "Ideal para entrenar al aire libre", precaucion: "Modera la intensidad", no: "Entrena en interiores" } },
    { id: "sensibles", titulo: "Grupos sensibles", ilustracion: "sensibles", estados: { si: "Sin riesgo", precaucion: "Precaución", no: "Protegerse" }, textos: { si: "Pueden salir con tranquilidad", precaucion: "Toma precauciones", no: "Evita exposición prolongada" } },
    { id: "ventilacion", titulo: "Hogar", ilustracion: "hogar", estados: { si: "Ventilar", precaucion: "Con cuidado", no: "No ventilar" }, textos: { si: "Buen momento para renovar el aire", precaucion: "Ventila por poco tiempo", no: "Mantén las ventanas cerradas" } },
  ];
  function pintarIlustraciones() {
    $$("[data-ilustracion]").forEach((contenedor) => {
      const svg = ILUSTRACIONES[contenedor.dataset.ilustracion];
      if (!svg) throw new Error(`Ilustración desconocida: ${contenedor.dataset.ilustracion}`);
      contenedor.innerHTML = svg;
    });
  }

  function pintarEscala(orden) {
    const etiquetas = NIVELES.map((texto, i) =>
      `<span class="escala__etiqueta ${i === orden ? "activo" : ""}">${texto}</span>`).join("");
    const tramos = COLOR_NIVEL.map((color, i) =>
      `<span class="escala__tramo ${i === orden ? "activo" : ""}" style="--nivel-color:${color}"></span>`).join("");
    const indicador = orden === null ? "" :
      `<span class="escala__indicador" style="--nivel-color:${COLOR_NIVEL[orden]};--posicion:${(orden + 0.5) * 20}%" aria-hidden="true"></span>`;
    const etiqueta = orden === null
      ? "Escala de calidad; se resaltará al calcular el pronóstico"
      : `Nivel pronosticado: ${NIVELES[orden]}`;
    $("#escala").innerHTML = `<div class="escala__pista" role="img" aria-label="${etiqueta}">${tramos}${indicador}</div>
      <div class="escala__etiquetas" aria-hidden="true">${etiquetas}</div>`;
  }

  function pintarRecomendaciones(lista) {
    const recomendaciones = new Map((lista || []).map((r) => [r.id, r]));
    const faltante = ACCIONES.find((accion) => !recomendaciones.has(accion.id));
    if (lista && faltante) {
      mostrarAviso(`No recibimos la recomendación de ${faltante.titulo.toLowerCase()}.`);
      return;
    }
    $("#recomendaciones").innerHTML = ACCIONES.map((accion) => {
      const r = recomendaciones.get(accion.id);
      const titulo = r ? esc(r.etiqueta) : accion.titulo;
      if (!r) {
        return `<article class="rec-card rec-card--pendiente">
          <div class="rec-card__visual rec-card__visual--${accion.ilustracion}"><span>${ILUSTRACIONES[accion.ilustracion]}</span></div>
          <div class="rec-card__contenido"><h4>${titulo}</h4>
            <strong class="rec-card__estado">Pendiente</strong>
            <p>Agrega datos para ver la recomendación.</p></div>
        </article>`;
      }
      const estadoRecomendacion = accion.estados[r.estado];
      if (!estadoRecomendacion) {
        mostrarAviso(`No reconocemos el estado de la recomendación de ${accion.titulo.toLowerCase()}.`);
        return `<article class="rec-card rec-card--pendiente">
          <div class="rec-card__visual rec-card__visual--${accion.ilustracion}"><span>${ILUSTRACIONES[accion.ilustracion]}</span></div>
          <div class="rec-card__contenido"><h4>${titulo}</h4><strong class="rec-card__estado">Sin recomendación</strong></div>
        </article>`;
      }
      return `<article class="rec-card rec-card--${esc(r.estado)}">
        <div class="rec-card__visual rec-card__visual--${accion.ilustracion}"><span>${ILUSTRACIONES[accion.ilustracion]}</span></div>
        <div class="rec-card__contenido"><h4>${titulo}</h4>
          <strong class="rec-card__estado">${estadoRecomendacion}</strong>
          <p class="rec-card__accion">${accion.textos[r.estado]}</p></div>
      </article>`;
    }).join("");
  }

  /* -----------------------------------------------------------------
     PASO 2 · Navegación y menú
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

  function mostrarVista() {
    const pedida = (location.hash || "#simulador").slice(1);
    const vista = ["simulador", "explicabilidad"].includes(pedida) ? pedida : "simulador";
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
  const btnPredecir = $("#btn-predecir");
  const estadoPrediccion = $("#estado-prediccion");

  function formularioValido() {
    if (!estado.filas.size) return false;
    for (const [id, li] of estado.filas) {
      const entrada = $(".dato__lectura", li);
      const valor = Number(entrada.value);
      if (!entrada.value.trim() || !entrada.validity.valid ||
          !Number.isFinite(valor) || valor < PORID[id].min_valido || valor > PORID[id].max_valido) {
        return false;
      }
    }
    return true;
  }

  function actualizarAccionPrediccion() {
    btnPredecir.disabled = !formularioValido() || Boolean(estado.peticion);
    if (!estado.filas.size) {
      estadoPrediccion.textContent = "Agrega datos y pulsa Predecir para ver el resultado.";
    } else if (estado.peticion) {
      estadoPrediccion.textContent = "Calculando el pronóstico…";
    } else if (!formularioValido()) {
      estadoPrediccion.textContent = "Revisa los valores marcados antes de predecir.";
    } else if (estado.cambiosPendientes) {
      estadoPrediccion.textContent = "Hay cambios sin predecir. Pulsa el botón para actualizar el resultado.";
    } else {
      estadoPrediccion.textContent = "El pronóstico está actualizado.";
    }
  }

  function marcarCambiosPendientes() {
    if (estado.peticion) {
      estado.peticion.abort();
      estado.peticion = null;
    }
    estado.cambiosPendientes = true;
    actualizarAccionPrediccion();
  }

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
    const maximoSlider = Math.max(v.max_deslizador ?? v.max, inicial, 1);
    const pasoSlider = 1 / (10 ** d);
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
        <div class="dato__medicion">
          <div class="dato__deslizador">
            <input type="range" class="dato__num" min="${v.min_valido}" max="${maximoSlider}" step="${pasoSlider}"
                   aria-label="Valor de ${esc(v.etiqueta)} en ${esc(v.unidad)}"
                   aria-describedby="dato-error-${id}" value="${inicial}">
            <div class="dato__extremos" aria-hidden="true"><span>${fmt(v.min_valido, d)}</span><span>${fmt(maximoSlider, d)}</span></div>
          </div>
          <label class="dato__lectura-contenedor">
            <span class="sr-only">Valor de ${esc(v.etiqueta)}</span>
            <input type="number" class="dato__lectura" min="${v.min_valido}" max="${v.max_valido}" step="${pasoSlider}"
                   aria-label="Valor de ${esc(v.etiqueta)} en ${esc(v.unidad)}"
                   aria-describedby="dato-error-${id}" value="${inicial}">
            <small class="dato__unidad">${esc(v.unidad)}</small>
          </label>
        </div>
        <small class="dato__error" id="dato-error-${id}" role="alert" hidden></small>
      </div>
      <div class="dato__estado"><i></i><span class="dato__estado-texto"></span><span class="dato__fuera" role="status" aria-live="polite" hidden>Fuera del rango de entrenamiento</span></div>`;

    const num = $(".dato__num", li);
    num.id = `dato-${id}`;
    const lectura = $(".dato__lectura", li);
    lectura.id = `dato-lectura-${id}`;
    const error = $(`#dato-error-${id}`, li);
    const mostrarError = (mensaje) => {
      error.textContent = mensaje;
      error.hidden = !mensaje;
      lectura.setAttribute("aria-invalid", String(Boolean(mensaje)));
      num.setAttribute("aria-invalid", String(Boolean(mensaje)));
    };
    const actualizarDeslizador = () => {
      const progreso = (Number(num.value) - Number(num.min)) / (Number(num.max) - Number(num.min)) * 100;
      num.style.setProperty("--progreso", `${progreso}%`);
    };
    const pintarEstado = (x) => {
      const [txt, color] = estadoDe(v, x);
      $(".dato__estado-texto", li).textContent = txt;
      $(".dato__estado i", li).style.background = color;
      $(".dato__fuera", li).hidden = !(x > v.max);
    };
    const sincronizarCampo = () => {
      const texto = lectura.value.trim();
      const x = texto === "" ? NaN : Number(texto);
      if (!Number.isFinite(x)) {
        mostrarError("Escribe un valor numérico.");
        return false;
      }
      if (x < v.min_valido || x > v.max_valido) {
        mostrarError(`Ingresa un valor entre ${fmt(v.min_valido, d)} y ${fmt(v.max_valido, d)}.`);
        return false;
      }
      if (lectura.validity.stepMismatch) {
        mostrarError(`Usa incrementos de ${fmt(pasoSlider, d)}.`);
        return false;
      }
      mostrarError("");
      num.value = String(Math.min(Number(num.max), Math.max(Number(num.min), x)));
      actualizarDeslizador();
      pintarEstado(x);
      return true;
    };
    actualizarDeslizador();
    lectura.value = String(Number(num.value));
    pintarEstado(Number(lectura.value));

    num.addEventListener("input", () => {
      const x = Number(num.value);
      lectura.value = String(x);
      mostrarError("");
      actualizarDeslizador();
      pintarEstado(x);
      marcarCambiosPendientes();
    });
    lectura.addEventListener("input", () => {
      const valido = sincronizarCampo();
      marcarCambiosPendientes();
      if (!valido) return;
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
    marcarCambiosPendientes();
  }

  function quitarVariable(id) {
    const li = estado.filas.get(id);
    if (!li) return;
    estado.filas.delete(id);
    li.classList.add("saliendo");
    setTimeout(() => li.remove(), 200);
    poblarSelector();
    if (estado.filas.size) marcarCambiosPendientes(); else reiniciarResultados();
  }

  function reiniciarResultados() {
    if (estado.peticion) estado.peticion.abort();
    estado.peticion = null;
    estado.resultado = null;
    estado.cambiosPendientes = false;
    const veredicto = $("#veredicto");
    delete veredicto.dataset.clave;
    veredicto.innerHTML = `<span class="veredicto__ilustracion">${ILUSTRACIONES.cielo}</span>
      <span class="veredicto__estado">
        <span class="veredicto__titulo">Tu pronóstico aparecerá aquí</span>
      </span>
      <div class="veredicto__resumen">
        <span class="veredicto__medicion">
          <span class="veredicto__etiqueta">PM₂.₅ mañana</span>
          <strong class="veredicto__valor"><span class="veredicto__numero">—</span> <span>µg/m³</span></strong>
        </span>
        <span class="veredicto__frase">Agrega datos para conocer el pronóstico.</span>
      </div>`;
    if (!estado.escena) estado.escena = window.Graficos.escena($("#escena"));
    estado.escena.actualizar(null);
    pintarEscala(null);
    pintarRecomendaciones(null);
    $("#alerta-local").hidden = true;
    $("#clima-manana").hidden = true;
    $("#mini-estado").classList.remove("visible");
    mostrarAviso("");
    actualizarAccionPrediccion();
    if (!$("#vista-explicabilidad").hidden) pintarPorque();
  }

  $("#btn-agregar").addEventListener("click", () => selector.value && agregarVariable(selector.value));
  btnPredecir.addEventListener("click", calcular);
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
    actualizarAccionPrediccion();
  }));

  /* -----------------------------------------------------------------
     PASO 4 · Lectura del formulario y envío con fetch()
     ----------------------------------------------------------------- */
  function leerFormulario() {
    const variables = [];
    for (const [id, li] of estado.filas) {
      const meta = PORID[id];
      const entrada = $(".dato__lectura", li);
      const x = Number(entrada.value);
      if (!entrada.value.trim() || !entrada.validity.valid ||
          !Number.isFinite(x) || x < meta.min_valido || x > meta.max_valido) return null;
      variables.push({ variable: id, valor: x });
    }
    return variables.length ? { variables } : null;
  }

  async function calcular() {
    const payload = leerFormulario();
    if (!payload) {
      actualizarAccionPrediccion();
      return;
    }
    if (estado.peticion) estado.peticion.abort(); // una respuesta vieja nunca pisa a una nueva
    const control = new AbortController();
    estado.peticion = control;
    actualizarAccionPrediccion();
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
      estado.cambiosPendientes = false;
      pintarResultado(datos);
      if (!$("#vista-explicabilidad").hidden) pintarPorque();
    } catch (e) {
      if (e.name !== "AbortError") mostrarAviso("Sin conexión con el servidor. ¿Está encendido Django?");
    } finally {
      if (estado.peticion === control) {
        estado.peticion = null;
        actualizarAccionPrediccion();
      }
    }
  }

  /* -----------------------------------------------------------------
     PASO 5 · Mi aire: cielo, escala, precisión, porqué y consejos
     ----------------------------------------------------------------- */
  function pintarResultado(d) {
    const a = d.alerta;

    // 5.1 El fondo y la lectura principal cambian según el nivel pronosticado
    if (!estado.escena) estado.escena = window.Graficos.escena($("#escena"));
    estado.escena.actualizar(a.orden);
    const ver = $("#veredicto");
    const titulo = TITULOS_NIVEL[a.orden] || a.titulo;
    const clave = a.orden + a.cara;
    const pronostico = d.predicciones.pm2_5;
    const mensajeNivel = [
      "¡Excelente para actividades al aire libre!",
      "Buenas condiciones para salir.",
      "Modera el esfuerzo al aire libre.",
      "Evita el ejercicio al aire libre.",
      "Permanece en interiores.",
    ][a.orden];
    if (ver.dataset.clave !== clave) { // solo «rebota» la cara si cambió el nivel
      ver.dataset.clave = clave;
      ver.innerHTML = `<span class="veredicto__ilustracion">${ILUSTRACIONES.cielo}</span>
        <span class="veredicto__estado">
          <span class="veredicto__titulo">${esc(titulo)}</span>
        </span>
        <div class="veredicto__resumen">
          <span class="veredicto__medicion">
            <span class="veredicto__etiqueta">PM₂.₅ mañana</span>
            <strong class="veredicto__valor"><span class="veredicto__numero">${fmt(pronostico.valor, 1)}</span> <span>µg/m³</span></strong>
          </span>
          <span class="veredicto__frase"></span>
        </div>`;
    }
    ver.querySelector(".veredicto__titulo").textContent = titulo;
    ver.querySelector(".veredicto__numero").textContent = fmt(pronostico.valor, 1);
    const frase = ver.querySelector(".veredicto__frase");
    frase.textContent = `${mensajeNivel}${a.contaminante === "pm10" ? " La categoría también considera PM₁₀." : ""}`;
    frase.setAttribute("aria-label", `${frase.textContent} ${a.frase}`);

    // 5.2 Barra de cinco estados con el nivel pronosticado destacado
    pintarEscala(a.orden);

    $("#alerta-local").hidden = !a.dia_critico_local;
    $("#alerta-local").innerHTML = `${icono("triangleAlert", "icon")} Mañana el aire estaría más sucio que en 9 de cada 10 días de la ciudad.`;

    // Clima de mañana usado por el modelo (escenario C)
    pintarClima(d.clima);
    // Consejos para hoy
    pintarRecomendaciones(d.recomendaciones);

    // Estado compacto para móvil
    const mini = $("#mini-estado");
    mini.style.background = COLOR_NIVEL[a.orden];
    mini.style.color = a.tinta;
    mini.innerHTML = `${icono(a.cara, "icon")} ${esc(a.titulo)}`;
    mini.classList.add("visible");
  }

  function pintarClima(c) {
    const caja = $("#clima-manana");
    caja.hidden = !c;
    if (!c) return;
    if (!c.disponible) {
      caja.innerHTML = `<p class="clima-manana__titulo">${icono("cloud", "icon")} Clima de mañana</p>
        <p class="clima-manana__fuente">${esc(c.fuente)}</p>`;
      return;
    }
    caja.innerHTML = `<p class="clima-manana__titulo">Clima de mañana</p>
      <div class="clima-manana__datos">${c.resumen.map((x) =>
        `<span class="clima-manana__dato">${icono(x.icono, "icon")} ${esc(x.nombre)}: <strong>${fmt(x.valor, 1)} ${esc(x.unidad)}</strong></span>`).join("")}
      </div>
      <p class="clima-manana__fuente">${esc(c.fuente)}.</p>`;
  }

  /* -----------------------------------------------------------------
     PASO 6 · ¿Por qué? — factores explicados en lenguaje cotidiano
     ----------------------------------------------------------------- */
  const EXPLICACIONES_FACTORES = {
    pm2_5: "Partículas microscópicas producidas por quema de combustibles, incendios y motores diésel. Por ser tan finas, ingresan directo a los pulmones.",
    sulphur_dioxide: "Dióxido de azufre generado por la combustión en industrias y transporte de carga pesada.",
    ozone: "Gas que se produce a nivel del suelo cuando la radiación solar y las altas temperaturas reaccionan con los gases de los vehículos.",
    pm10: "Partículas de polvo del suelo, cenizas y material suspendido levantado por el viento y obras viales.",
    carbon_monoxide: "Monóxido de carbono emitido por vehículos, especialmente en situaciones de congestión o tráfico lento.",
    lluvia: "La lluvia de mañana lava el aire: las gotas arrastran las partículas hasta el suelo.",
    viento: "El viento dispersa la contaminación y la saca del valle; con poco viento el humo se acumula.",
    temperatura: "Noches frías y días calientes indican un aire quieto que atrapa la contaminación cerca del suelo.",
    capa_mezcla: "Altura hasta donde se mezcla el aire. Si es baja, la contaminación queda atrapada como bajo una tapa.",
    humedad: "La humedad alta favorece la formación de partículas microscópicas que irritan los pulmones.",
    };

  function estadoSalud(variable, valor) {
    const umbral = PORID[variable]?.umbral_seguro;
    if (!Number.isFinite(Number(valor)) || !Number.isFinite(Number(umbral)) || Number(umbral) <= 0) {
      return { etiqueta: "Dato ambiental", clase: "factor__salud--neutral" };
    }

    const proporcion = Number(valor) / Number(umbral);
    if (proporcion <= 0.25) return { etiqueta: "Muy bajo", clase: "factor__salud--muy-bajo" };
    if (proporcion <= 1) return { etiqueta: "Bueno / Saludable", clase: "factor__salud--bueno" };
    if (proporcion <= 1.5) return { etiqueta: "Aceptable", clase: "factor__salud--aceptable" };
    return { etiqueta: "Conviene tener cuidado", clase: "factor__salud--cuidado" };
  }

  function tarjetaFactor(f, maxAporte, favorable, esPrincipal) {
    const peso = Math.min(100, Math.max(15, Math.abs(f.aporte) / maxAporte * 100));
    const unidad = f.unidad === "adim." || f.unidad === "índice" ? "" : ` ${esc(f.unidad)}`;
    const decimalesValor = f.valor < 5 ? 2 : 1;
    const salud = f.tipo === "clima"
      ? { etiqueta: "Clima de mañana", clase: "factor__salud--neutral" }
      : estadoSalud(f.variable, f.valor);
    const accion = favorable ? "limpieza" : "concentración";
    const impacto = esPrincipal
      ? `Aporte principal a la ${accion}`
      : `${peso >= 40 ? "Aporte moderado" : "Aporte leve"} a la ${accion}`;
    const explicacion = EXPLICACIONES_FACTORES[f.variable] || f.que_es;
    const idAyuda = `factor-ayuda-${f.variable}`;
    return `<article class="factor ${favorable ? "factor--favorable" : "factor--desfavorable"} ${f.origen === "estimada" ? "factor--estimada" : ""}"
              aria-label="${esc(f.nombre_comun)} (${esc(f.etiqueta)}): ${fmt(f.valor, decimalesValor)}${unidad}, ${salud.etiqueta}. ${impacto}.">
      <span class="factor__ico" aria-hidden="true">${icono(f.icono, "icon")}</span>
      <div class="factor__encabezado">
        <h3 class="factor__nombre">${esc(f.nombre_comun)}</h3>
        <span class="factor__variable">
          ${esc(f.etiqueta)}
          ${explicacion ? `<span class="factor__ayuda-wrap">
            <button class="factor__ayuda" type="button" aria-label="Qué significa ${esc(f.etiqueta)}" aria-expanded="false" aria-describedby="${idAyuda}">ℹ</button>
            <span class="factor__tooltip" id="${idAyuda}" role="tooltip">${esc(explicacion)}</span>
          </span>` : ""}
        </span>
      </div>
      <div class="factor__medicion">
        <strong class="factor__valor">${fmt(f.valor, decimalesValor)}${unidad}</strong>
        <span class="factor__salud ${salud.clase}">${salud.etiqueta}</span>
      </div>
      <div class="aporte__pista" role="progressbar" aria-label="Peso relativo del factor" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(peso)}">
        <span style="width:${peso}%"></span>
      </div>
      <p class="factor__impacto">${impacto}</p>
      ${f.origen === "estimada" ? `<span class="factor__estimada">Dato estimado</span>` : "" }
    </article>`;
  }

  const dialogoAyuda = $("#xai-dialogo");
  const botonAbrirAyuda = $("#xai-abrir-ayuda");
  function cerrarTooltips(excepto = null) {
    $$(".factor__ayuda[aria-expanded='true']", $("#col-factores"))
      .filter((boton) => boton !== excepto)
      .forEach((boton) => boton.setAttribute("aria-expanded", "false"));
  }
  botonAbrirAyuda.addEventListener("click", () => dialogoAyuda.showModal());
  $("#xai-cerrar-ayuda").addEventListener("click", () => dialogoAyuda.close());
  $("#xai-listo-ayuda").addEventListener("click", () => dialogoAyuda.close());
  dialogoAyuda.addEventListener("click", (evento) => {
    if (evento.target === dialogoAyuda) dialogoAyuda.close();
  });
  dialogoAyuda.addEventListener("close", () => botonAbrirAyuda.focus());

  $("#col-factores").addEventListener("click", (evento) => {
    const boton = evento.target.closest(".factor__ayuda");
    if (!boton) {
      cerrarTooltips();
      return;
    }
    const abrir = boton.getAttribute("aria-expanded") !== "true";
    cerrarTooltips(boton);
    boton.setAttribute("aria-expanded", String(abrir));
  });
  $("#col-factores").addEventListener("keydown", (evento) => {
    if (evento.key !== "Escape") return;
    const boton = evento.target.closest(".factor__ayuda");
    if (boton && boton.getAttribute("aria-expanded") === "true") {
      boton.setAttribute("aria-expanded", "false");
      boton.focus();
    }
  });

  function pintarPorque() {
    const d = estado.resultado;
    $("#xai-vacio").hidden = !!d;
    $("#xai-contenido").hidden = !d;
    if (!d) return;
    const a = d.alerta, s = d.explicacion[a.contaminante].simple;
    const relevantes = [
      ...s.favorables.map((f) => ({ ...f, ayuda: true })),
      ...s.desfavorables.map((f) => ({ ...f, ayuda: false })),
    ].sort((x, y) => Math.abs(y.aporte) - Math.abs(x.aporte));
    const maxAporte = Math.max(...relevantes.map((f) => Math.abs(f.aporte)), 0.01);
    const objetivo = a.contaminante === "pm2_5" ? "PM₂.₅" : "PM₁₀";
    const saludables = a.orden === 0;
    const factorPrincipal = relevantes[0];
    const influencia = factorPrincipal
      ? `Lo que más pesa es ${factorPrincipal.tipo === "clima" ? "el clima de mañana: " : ""}${factorPrincipal.nombre_comun}, junto con los demás datos del aire.`
      : "El resultado combina los datos ingresados y los estimados automáticamente.";
    const estadoHumano = saludables
      ? "se mantiene en niveles saludables"
      : a.orden === 1
        ? "se mantiene en un nivel aceptable para la mayoría"
        : a.orden === 2
          ? "requiere precaución para las personas sensibles"
          : "puede afectar la salud; conviene limitar las actividades al aire libre";
    $("#xai-frase").textContent = `El pronóstico de ${objetivo} (${fmt(s.prediccion, 1)} µg/m³) ${estadoHumano}. ${influencia}`;
    $("#col-factores").innerHTML = relevantes.length
      ? relevantes.map((f, i) => tarjetaFactor(f, maxAporte, f.ayuda, i === 0)).join("")
      : `<div class="columna__vacia">No hay factores relevantes para mostrar.</div>`;
    $("#xai-nota").textContent = [
      s.hay_estimadas ? "Los datos con la etiqueta «Estimado automáticamente» se completaron porque no fueron ingresados." : "",
      "La explicación resume patrones aprendidos por el modelo; no demuestra una causa directa.",
    ].filter(Boolean).join(" ");

  }

  /* -----------------------------------------------------------------
     PASO 7 · Arranque
     ----------------------------------------------------------------- */
  if (!CONFIG.listo) mostrarAviso("La interfaz está disponible, pero las predicciones no. " + (CONFIG.error_carga || ""));
  estado.escena = window.Graficos.escena($("#escena"));
  pintarIlustraciones();
  poblarSelector();
  mostrarVista();
})();
