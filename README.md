# Aire Claro v3 · Simulador de calidad del aire con IA explicable

Plataforma Django para simular y anticipar la calidad del aire (PM2.5 y PM10, próximas 24 h) a partir de **magnitudes instantáneas**, sin fechas. El usuario arma su propio conjunto de variables, recibe un semáforo de 5 niveles con recomendaciones prácticas y una explicación SHAP en lenguaje cotidiano.

## Módulos (pensados para público general)

| Pantalla | Qué ve el usuario |
|---|---|
| **Mi aire** (simulador) | Agrega datos con un selector y los ajusta con barras deslizantes de colores (verde normal · ámbar alto · rojo no saludable). Todo se recalcula al instante: el cielo de una ciudad animada se aclara o se llena de bruma, una escala de 5 caras marca el nivel y aparecen 5 consejos de máximo seis palabras (ciclismo, correr, tapabocas, ventilar, niños). Un indicador de precisión sugiere el siguiente dato más útil. |
| **¿Por qué?** (explicabilidad) | Una frase y un «tira y afloja»: a un lado lo que **limpia** el aire, al otro lo que lo **ensucia**, con flechas ▲▲▲ según su influencia. Las tarjetas giran al tocarlas para explicar qué es cada cosa. Sin números ni jerga. |
| **¿Es confiable?** (comparador) | Un tiro al blanco: cada dardo es un método y el más cercano al centro es el que menos falla. Cuatro insignias explican la elección y su límite. |

El interruptor **Modo técnico** (pie del menú) muestra para evaluadores las cifras en µg/m³, el gráfico SHAP por variable, la comprobación aditiva y la tabla completa de métricas.

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
python manage.py test simulador    # 13 pruebas
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
├── ml_models/                   .joblib + benchmark_modelos.json (generados)
├── scripts/construir_artefactos.py
├── simulador/
│   ├── ml_service.py            pipeline: validar → imputar → 21 variables → predecir → SHAP
│   ├── ml/
│   │   ├── catalogo.py          variables, umbrales OMS, cortes ICA, recomendaciones, resultados tesis
│   │   ├── datos.py             limpieza + ingeniería de variables (compartido con el entrenamiento)
│   │   ├── explicadores.py      shap → contribuciones nativas → TreeSHAP propio
│   │   └── narrativa.py         SHAP → frases en lenguaje claro
│   ├── views.py · urls.py · tests.py
│   ├── templates/simulador/index.html
│   └── static/simulador/  css/styles.css · js/app.js · js/charts.js
├── README.md
└── DOCUMENTACION_FLUJO_DE_DATOS.md   ← recorrido didáctico pantalla → SHAP
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
