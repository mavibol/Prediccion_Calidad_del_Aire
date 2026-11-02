# Aire Claro v3 · Simulador de calidad del aire con IA explicable

Plataforma Django para simular y anticipar la calidad del aire (PM2.5 y PM10, próximas 24 h) a partir de **magnitudes instantáneas**, sin fechas. El usuario arma su propio conjunto de variables, recibe un semáforo de 5 niveles con recomendaciones prácticas y una explicación SHAP en lenguaje cotidiano.

## Módulos (pensados para público general)

| Pantalla | Qué ve el usuario |
|---|---|
| **Mi aire** (simulador) | Agrega variables e introduce sus valores. Cada campo muestra un amplio rango de plausibilidad, independiente de los máximos observados en el dataset; el servidor rechaza valores fuera de esos límites. Todo se recalcula al instante: un fondo sutil cambia de tono según el nivel, un indicador vectorial marca el estado y aparecen 5 consejos. |
| **¿Por qué?** (explicabilidad) | Atribuciones TreeSHAP agrupadas por dirección: aportes que disminuyen el valor predicho y aportes que lo incrementan. Muestra su magnitud en µg/m³, una barra comparativa, el valor base E[f(X)] y la predicción. Las tarjetas giran al tocarlas para explicar cada variable. |
| **¿Es confiable?** (comparador) | En modo técnico muestra MAE/RMSE de validación y prueba, completitud, método de imputación y un rango predictivo empírico P95 calibrado con validación cronológica. También compara modelos y explica sus límites. |

El interruptor **Modo técnico** (pie del menú) muestra para evaluadores una cascada interactiva con aportes SHAP exactos por característica, la comprobación aditiva y los errores MAE/RMSE. El botón **Modelo listo** de la barra lateral abre la ficha del algoritmo y sus métricas de validación.

El rango predictivo se calibra con errores absolutos del conjunto de validación; es una referencia empírica, no un intervalo de confianza para parámetros ni una cobertura garantizada. Los errores pueden cambiar con el tiempo y las condiciones.

El formulario usa nomenclatura formal (por ejemplo, PM₁₀ y PM₂.₅) y las unidades del dataset. Solo ofrece las nueve variables que realmente alimentan al modelo; temperatura, humedad relativa, radiación solar y velocidad del viento no forman parte del dataset/modelo actual.

## Puesta en marcha

```bash
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

**Opción A — usar tus modelos de Colab (recomendado).** Copia `modelo_pm2_5_XGBoost.joblib`, `modelo_pm10_XGBoost.joblib` (y, si lo tienes, `metadatos_modelos.json`) a `ml_models/`. Luego genera el benchmark (no sobrescribe tus modelos):

```bash
python scripts/construir_artefactos.py
```

También puedes exportar los modelos XGBoost ya entrenados en formato nativo `.json` desde Colab. Si están presentes, la aplicación prefiere esos archivos a los `.joblib` con el mismo nombre base; así se evitan incompatibilidades de serialización entre versiones:

```python
modelo.save_model("modelo_pm2_5_XGBoost.json")
```

Coloca ambos JSON (`modelo_pm2_5_XGBoost.json` y `modelo_pm10_XGBoost.json`) en `ml_models/`. No es necesario volver a entrenar los modelos.

**Opción B — entrenar aquí.** Si `ml_models/` está vacío, el mismo comando entrena XGBoost con el protocolo y los hiperparámetros del notebook del Capítulo 2 (Tabla 10) y guarda los `.joblib`.

Después:

```bash
python manage.py test simulador    # pruebas del simulador
python manage.py runserver
```

Abre http://127.0.0.1:8000/

## Estructura

```
aire_claro_v3/
├── manage.py
├── requirements.txt
├── config/                      settings.py · urls.py · wsgi.py · asgi.py
├── datos/air_quality_historical.csv
├── ml_models/                   modelos .joblib o .json + benchmark_modelos.json
├── scripts/construir_artefactos.py
├── simulador/
│   ├── ml_service.py            pipeline: validar -> imputar -> 21 variables -> predecir -> SHAP
│   ├── ml/
│   │   ├── catalogo.py          variables, umbrales OMS, cortes ICA, recomendaciones, resultados tesis
│   │   ├── datos.py             limpieza + ingeniería de variables (compartido con el entrenamiento)
│   │   ├── explicadores.py      shap -> contribuciones nativas -> TreeSHAP propio
│   │   └── narrativa.py         SHAP -> frases en lenguaje claro
│   ├── views.py · urls.py · tests.py
│   ├── templates/simulador/index.html
│   └── static/simulador/  css/styles.css · js/app.js · js/charts.js · js/icons.js
├── README.md
└── DOCUMENTACION_FLUJO_DE_DATOS.md   recorrido didáctico de la pantalla a SHAP
```

## API

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/variables/` | Catálogo de variables válidas con estadísticas e importancia |
| POST | `/api/predecir/` | Predicción + semáforo + recomendaciones + SHAP (requiere token CSRF) |
| GET | `/api/benchmark/` | Benchmark calculado + resultados oficiales de la tesis |
| GET | `/api/estado/` | Modelos cargados, explicador en uso, P90, MAE de prueba |

Ejemplo de cuerpo para `/api/predecir/`:

```json
{"variables": [
  {"variable": "pm2_5", "valor": 24.5, "valor_previo": 17},
  {"variable": "nitrogen_dioxide", "valor": 21}
]}
```

## Configuración

| Variable de entorno | Valor por defecto | Uso |
|---|---|---|
| `DJANGO_SECRET_KEY` | clave de desarrollo | **Obligatoria en producción** |
| `DJANGO_DEBUG` | `1` | `0` en producción |
| `DJANGO_ALLOWED_HOSTS` | `localhost,127.0.0.1` | Dominios permitidos |
| `AIRE_IMPUTACION` | `iterativa` | `mediana` para imputación simple |

## Notas

- Los `.joblib` deben cargarse con las mismas versiones de librerías con que se exportaron (por eso `requirements.txt` fija las de Colab).
- `shap` es opcional: si no se instala, la app usa las contribuciones nativas de XGBoost, que calculan el mismo TreeSHAP.
- Los gráficos son SVG propios, sin CDN: la aplicación funciona sin conexión a internet.
- La limpieza, las 21 variables (`ma3 = media(t−1, t−2, t−3)` con mínimo 2 días, `delta = (t−1) − (t−2)`, `dia_semana` 0 = lunes), los hiperparámetros y el criterio de selección son los del notebook `E2_Capitulo2`. Se reproducen las 1.294 filas, la partición 906/194/194, los P90 (18,35 / 25,56) y el MAE de persistencia (3,125 / 3,242) de la tesis.
