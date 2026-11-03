# Cómo viajan los datos: desde la pantalla hasta SHAP

Este documento sigue **un dato concreto** desde que el usuario lo escribe en el simulador hasta que aparece como una barra roja en el panel de explicabilidad. Está pensado para el capítulo 3.9 de la tesis y para quien mantenga la aplicación.

Ejemplo que usaremos de principio a fin: el usuario agrega **PM2.5 = 24,5 µg/m³** (con lectura anterior **17**) y **NO₂ = 21 µg/m³**. Nada más.

```
 NAVEGADOR                                   SERVIDOR DJANGO
 ---------                                   ---------------
 1. Catálogo embebido (json_script)
 2. Constructor dinámico  [PM2.5: 24,5 | 17]
                          [NO2   : 21       ]
 3. leerFormulario() valida los datos localmente
 4. fetch POST /api/predecir/  ------>  5. views.api_predecir (método, JSON, CSRF)
                                        6. ServicioML.validar() (variables válidas, números)
                                        7. ServicioML.imputar() (7 variables ausentes)
                                        8. fila_desde_lecturas() (9 lecturas a 21 variables)
                                        9. 84 escenarios de calendario (12 meses x 7 días)
                                       10. modelo.predict() calcula el promedio
                                       11. TreeSHAP calcula las contribuciones promedio
                                       12. Agregación por variable, narrativa y semáforo
 13. pintarResultados() / pintarExplicacion() <------ JSON de respuesta
```

---

## 1. El catálogo: la única fuente de variables válidas

Al cargar la página, la vista `inicio` llama a `ServicioML.catalogo_publico()` y Django incrusta la lista en el HTML con el filtro `json_script` (no requiere una petición adicional y es seguro frente a inyección de código):

```html
<script id="catalogo-variables" type="application/json">[{"id": "pm10", "etiqueta": "PM10", "importancia": 1.0, "mediana": 16.8, ...}, ...]</script>
```

Solo contiene las **9 variables predictoras del dataset** (PM₂.₅, PM₁₀, CO, NO₂, SO₂, O₃, AOD, polvo y UV). `us_aqi` y `european_aqi` están en el CSV pero se excluyen: son índices calculados a partir del mismo material particulado y no son entradas del modelo. El dataset/modelo actual no contiene temperatura, humedad relativa, radiación solar ni velocidad del viento; por eso no se muestran como entradas.

El formulario presenta primero la nomenclatura formal y la unidad del dataset. En particular, NO₂ se conserva en µg/m³ tal como está almacenado; no se etiqueta como ppb ni se convierte sin información de temperatura y presión. El nombre común y la explicación permanecen como texto secundario y ayuda.

Cada variable trae sus estadísticas de entrenamiento (mediana, P10, P90, máximo), su umbral sanitario de la OMS cuando existe y su **importancia global** (|SHAP| medio), que se comunica como texto en el selector para orientar al usuario hacia las variables que más información aportan. Las variables y estados usan iconos SVG locales.

## 2. El constructor dinámico (app.js, PASO 3)

No hay formulario fijo. El `<select>` se reconstruye cada vez que cambia la lista (`poblarSelector()`) y **solo ofrece variables que aún no se han agregado**. Así es imposible, desde la interfaz, enviar duplicados o variables inexistentes.

`agregarVariable(id)` crea una fila con:

- **Valor actual** (obligatorio): se convertirá en la variable `_lag1` del modelo.
- **Valor anterior** (opcional, solo para los 6 contaminantes que el modelo usa con dos rezagos): se convertirá en `_lag2` y permite calcular tendencia (`delta`) y media móvil (`ma3`).
- Un campo numérico para escribir el valor, sin deslizador ni tope superior en la interfaz.

## 3. Validación en el navegador (PASO 4)

`leerFormulario()` recorre las filas y arma el *payload*:

```json
{"variables": [
  {"variable": "pm2_5", "valor": 24.5, "valor_previo": 17},
  {"variable": "nitrogen_dioxide", "valor": 21, "valor_previo": null}
]}
```

Acepta coma o punto decimal (`aNumero("24,5")` devuelve `24.5`) y marca en rojo los campos vacíos, no numéricos o negativos. Esta validación es solo de cortesía: **el servidor vuelve a validar todo**.

## 4. El envío asíncrono (PASO 5)

`calcular()` envía el JSON con `fetch()`:

```js
fetch(CONFIG.api.predecir, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-CSRFToken": CSRF },
  body: JSON.stringify(payload),
  signal: control.signal,       // AbortController: si llega otra petición, se cancela esta
});
```

- El token CSRF se lee de `<meta name="csrf-token">`, que Django rellena con `{{ csrf_token }}`.
- En el modo **«¿qué pasaría si…?»**, cada cambio de valor programa un recálculo con *debounce* de 650 ms; el `AbortController` garantiza que una respuesta vieja nunca pise a una nueva.

## 5-6. Validación en el servidor

`views.api_predecir` comprueba el transporte (POST, `application/json`, JSON bien formado, CSRF) y delega en `ServicioML.validar()`, que rechaza con **HTTP 400** y un mensaje en español: variables fuera del catálogo, repetidas, valores no numéricos o por fuera de los límites amplios de plausibilidad definidos por variable. Estos límites no derivan del dataset ni son umbrales regulatorios o rangos certificados de instrumentos; el mismo rango se muestra bajo cada campo en el formulario. Los valores dentro del límite pero por encima del histórico se aceptan con un aviso sobre extrapolación.

## 7. Imputación de las variables que el usuario no dio

En el ejemplo faltan 7 de 9 variables. El modelo necesita todas, así que `ServicioML.imputar()` las estima con un **`IterativeImputer` ajustado solo con los días de entrenamiento** (sin fuga de información de validación o prueba).

¿Por qué no usar simplemente la mediana? Porque las variables están correlacionadas. Si el usuario dice que el PM2.5 está en 24,5 (alto para la ciudad), la mediana de PM10 (≈ 17) sería incoherente; el imputador iterativo estima PM10 ≈ 32,7, coherente con la relación PM2.5–PM10 observada. (La estrategia se puede cambiar a mediana con `AIRE_IMPUTACION=mediana`.)

Las variables estimadas se marcan como **«estimada»** en la interfaz para que el usuario sepa qué parte de la explicación descansa en supuestos.

## 8. De 9 lecturas a las 21 variables del modelo

El modelo desplegado (escenario A de la tesis) no recibe «PM2.5», sino 21 variables construidas a partir de los días previos. `fila_desde_lecturas()` (en `simulador/ml/datos.py`, **el mismo módulo que construye la matriz de entrenamiento**) hace la traducción:

| Variable del modelo | Con lectura anterior (PM2.5) | Sin lectura anterior (NO₂) |
|---|---|---|
| `_lag1` | 24,5 (lectura actual) | 21 |
| `_lag2` | 17 (lectura anterior) | 21 (se asume persistencia) |
| `pm2_5_ma3` = media(t−1, t−2, t−3) | (24,5 + 17 + 17) / 3 = 19,5 | — |
| `pm2_5_delta` = (t−1) − (t−2) | 24,5 − 17 = +7,5 (empeorando) | — |

Cuando falta la lectura anterior se asume **persistencia** (el valor de ayer es igual al de hoy): es el supuesto más neutral, coherente con la alta autocorrelación de la serie (ACF(1) = 0,64 para PM2.5), y produce `delta = 0`, es decir, «sin tendencia».

## 9. Sin fechas: los 84 escenarios de calendario

El modelo también usa `mes` y `dia_semana`, pero el simulador es **agnóstico al tiempo**: el usuario no da fecha. En lugar de inventar una, el servicio evalúa la misma fila en las **12 × 7 = 84 combinaciones** de mes y día de la semana y promedia. El resultado se interpreta como «la calidad del aire esperada con estas condiciones, en una época cualquiera del año».



## 10. Predicción

Cada uno de los dos modelos (PM2.5 y PM10) predice las 84 filas y se toma el promedio. Los nombres y el orden de columnas se leen **del propio modelo** (`feature_names_in_` o `get_booster().feature_names`), y `nombre_canonico()` acepta alias (`NO2_lag1`, `pm25_ma3`, `month`…) para que los `.joblib` exportados desde Colab funcionen sin renombrar nada.

## 11. SHAP: cuánto empujó cada variable

Para cada fila, TreeSHAP calcula un valor φᵢ por variable, que cumple la **propiedad aditiva**:

> predicción = valor base + φ₁ + φ₂ + … + φ₂₁

donde el valor base es la predicción media del modelo sobre los datos de entrenamiento («un día típico», ≈ 13,2 µg/m³ para PM2.5).

Como la predicción final es el promedio de 84 filas, se promedian también sus explicaciones. La aditividad se conserva porque el promedio de sumas es la suma de promedios:

> promedio(pred) = base + promedio(φ₁) + … + promedio(φ₂₁)

La propiedad aditiva permite resumir las contribuciones de las variables derivadas en factores que el usuario reconoce. La interfaz presenta únicamente esa explicación resumida.

El explicador se elige en cascada (`simulador/ml/explicadores.py`):

1. `shap.TreeExplainer` (la librería usada en la tesis);
2. las contribuciones nativas de XGBoost (`pred_contribs=True`) o LightGBM, que implementan el mismo algoritmo en C++;
3. un TreeSHAP propio en Python para árboles de scikit-learn (validado contra el cálculo exacto por fuerza bruta).

## 12. De 21 contribuciones a una explicación para no expertos

Mostrar `pm2_5_ma3`, `pm2_5_delta` y `pm2_5_lag2` por separado confunde a un ciudadano. Por eso `_explicacion()` **suma las contribuciones de todas las variables derivadas de una misma medición**:

> aporte(PM2.5) = φ(`pm2_5_lag1`) + φ(`pm2_5_lag2`) + φ(`pm2_5_ma3`) + φ(`pm2_5_delta`)

Así el usuario ve una explicación resumida por variable, en lenguaje cotidiano. Las contribuciones internas del calendario y de las variables derivadas no se presentan en la interfaz.

El **semáforo** (`_alerta()`) ubica cada predicción en los cortes del ICA de la Resolución 2254 de 2017 y los mapea a 5 niveles (Buena: Sin contaminación; Aceptable: Bajo; Dañina para grupos sensibles: Moderado; Dañina: Alto; Muy dañina / Peligrosa: Crítico). Se toma **el peor entre el pronóstico y las lecturas actuales de PM que dio el usuario**. Los valores superiores al máximo histórico se aceptan, pero la aplicación advierte que la predicción puede ser menos confiable fuera del rango de entrenamiento. Si el pronóstico supera el P90 de entrenamiento se muestra la insignia «día crítico local» de la tesis.

## 13. Presentación en pantalla

La API entrega una explicación resumida (`simple`, generada por `explicacion_simple()` en `narrativa.py`); la interfaz la presenta junto con el estado, el pronóstico y las recomendaciones:

- **Banner de estado** (`Graficos.escena`): un fondo degradado y sutil cambia de tono según el nivel, sin siluetas de edificios. El estado se acompaña con iconos SVG y texto, nunca solo con color.
- **¿Por qué?**: presenta factores favorables y desfavorables en lenguaje cotidiano, con sus valores medidos o estimados y una barra de influencia relativa. La interpretación es relativa al modelo y no implica causalidad.
- **Estado de cada dato** («por encima de lo saludable», «más alto de lo normal», «normal», «más bajo de lo normal») con la guía OMS y los percentiles 10 y 90 de la ciudad. Si el estado contradice el efecto (p. ej., un valor bajo que el modelo asocia con más contaminación), se omite el estado para no confundir.
- **Completitud**: muestra la cantidad y el porcentaje de variables ingresadas sobre las nueve disponibles.
- **Estimaciones**: identifica los valores que el sistema completó automáticamente porque no fueron ingresados.

---

## Resumen de decisiones y supuestos (para la sección de limitaciones)

| Decisión | Motivo | Riesgo / cómo se comunica |
|---|---|---|
| Imputación iterativa con datos de entrenamiento | Coherencia entre variables correlacionadas | Las variables completadas se identifican como estimadas |
| Persistencia cuando falta la lectura anterior | Supuesto neutral, alta autocorrelación | Se usa internamente para construir variables derivadas |
| Promedio sobre 84 combinaciones de calendario | El simulador no usa fechas | Barra «Calendario (promedio de todo el año)» |
| Semáforo = peor entre pronóstico y lectura actual | Los árboles no extrapolan | Frase de motivo explícita + aviso de valores fuera de rango |
| Agregación de las 21 variables en 9 + calendario | Comprensión para no expertos | La interfaz presenta solo los factores reconocibles por el usuario |
| ma3 = media(t−1,t−2,t−3), delta = (t−1)−(t−2) | Mismas definiciones del notebook del Capítulo 2 | Confirmado: se reproducen las 1.294 filas |
