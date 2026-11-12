# Aire Claro · Simulador de calidad del aire con IA explicable

Plataforma Django para simular y anticipar la calidad del aire en el Valle de Aburrá (PM2.5 y PM10, próximas 24 h). El usuario escribe lo que sabe del aire de hoy y la aplicación descarga sola el **pronóstico del clima de mañana**. Con ambos datos, el modelo seleccionado en la tesis (**escenario C: pronóstico a 24 h + meteorología, LightGBM**) estima el aire de mañana. El resultado se presenta con un semáforo de 5 niveles, recomendaciones prácticas y una explicación SHAP en lenguaje cotidiano.

## Módulos (pensados para público general)

| Pantalla | Qué ve el usuario |
|---|---|
| **Mi aire** (simulador) | Agrega variables e introduce sus valores. Cada campo muestra un rango amplio de valores plausibles y el servidor rechaza los que estén fuera de esos límites. El visualizador presenta el estado, el pronóstico de PM₂.₅, una escala de calidad y la tarjeta **«Clima de mañana»** (lluvia, viento, temperatura y nubes usados por el modelo). Tres tarjetas resumen recomendaciones para deporte, grupos sensibles y el hogar. |
| **Factores del Aire** (explicabilidad) | Una explicación narrativa de los factores con mayor influencia, seguida de los que ayudan a limpiar el aire y los que pueden aumentar la contaminación. Incluye los **factores de clima** (lluvia, viento, temperatura, humedad, nubes y sol, presión, altura de mezcla). La interpretación no implica causalidad. |
| **Resultados** | Evaluación retrospectiva de PM₂.₅ o PM₁₀ en el periodo de prueba: error del modelo, comparación con repetir el valor del día anterior, gráfico de valores medidos y pronosticados, partición cronológica, factores globales asociados a la predicción y análisis de días críticos. También compara los escenarios sin clima y con clima en validación. |

El formulario ofrece las nueve variables de calidad del aire que alimentan el modelo: PM₁₀, PM₂.₅, SO₂, NO₂, O₃, CO, AOD, índice UV y polvo. Las variables meteorológicas no se escriben: se descargan del pronóstico de Open-Meteo.

La pantalla **Resultados** es distinta del pronóstico interactivo: resume cómo se comportó el modelo con días reservados para evaluación. El selector permite cambiar entre PM₂.₅ y PM₁₀. Las métricas del periodo de prueba se calculan con las predicciones de los modelos desplegados; la comparación de escenarios A y C proviene de los resultados de validación del notebook.

## Modelo desplegado

- **Escenario C** del Capítulo 2: 51 variables.
  - 21 variables del escenario A: rezagos y promedios de los contaminantes, aerosoles y calendario.
  - 15 variables meteorológicas del día pronosticado.
  - Las mismas 15 variables del día anterior.
- **Algoritmo:** LightGBM para PM2.5 y para PM10, seleccionado por validación en el notebook `E2_Capitulo2`.
- **Desempeño en prueba:** PM2.5 MAE 2,40 µg/m³ (R² 0,37); PM10 MAE 2,49 µg/m³ (R² 0,39). Es un 23 % mejor que la persistencia.

## Puesta en marcha

```bash
py -3.12 -m venv .venv
.venv\Scripts\activate            # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
```

Se recomienda **Python 3.12 o 3.13**, porque `requirements.txt` fija las versiones de Colab.

1. Copien a `ml_models/` los archivos exportados en la sección 11 del notebook `E2_Capitulo2`:
   - `modelo_pm2_5.txt`
   - `modelo_pm10.txt`
   - `metadatos_modelos.json`
2. Copien `meteorologia_diaria.csv` del mismo zip a `datos/`.
3. Ejecuten:

```bash
python manage.py test simulador
python manage.py runserver
```

Abran http://127.0.0.1:8000/

## Clima de mañana

El modelo necesita el tiempo de **hoy** y de **mañana**. Al calcular un pronóstico, `simulador/ml/meteo.py` descarga el pronóstico horario de Open-Meteo (`forecast_days=2`) para las coordenadas de `metadatos_modelos.json`. Luego lo resume por día con las mismas reglas de la sección 12 del notebook del EDA:
- la lluvia se suma en las 24 horas;
- la temperatura, el viento, la humedad y las nubes se promedian.

- **Consulta en caché:** la descarga se guarda una hora, así que la página no se vuelve lenta al mover los deslizadores.
- **Sin internet:** la aplicación usa el clima típico del mes (el de hoy para los rezagos y el de mañana para el día pronosticado), calculado con `datos/meteorologia_diaria.csv`, y lo avisa en la tarjeta. Reintenta la descarga a los 10 minutos.

## Estructura

```
Calidad del aire/
├── manage.py
├── requirements.txt
├── config/                      settings.py · urls.py · wsgi.py · asgi.py
├── datos/
│   ├── air_quality_historical.csv   calidad del aire (Open-Meteo Air Quality API, CAMS)
│   └── meteorologia_diaria.csv      meteorología diaria (Open-Meteo, reanálisis ERA5)
├── ml_models/                   modelo_pm2_5.txt · modelo_pm10.txt · metadatos_modelos.json
├── simulador/
│   ├── ml_service.py            validar -> imputar -> clima -> 51 variables -> predecir -> SHAP
│   ├── ml/
│   │   ├── catalogo.py          variables, factores de clima, umbrales OMS, cortes ICA, recomendaciones
│   │   ├── datos.py             limpieza + ingeniería de variables (igual que el notebook)
│   │   ├── meteo.py             descarga y agregación diaria del pronóstico del clima
│   │   ├── explicadores.py      shap -> contribuciones nativas de LightGBM -> TreeSHAP propio
│   │   ├── narrativa.py         SHAP -> factores para explicar en lenguaje claro
│   │   └── resultados.py        métricas de prueba, factores globales y días críticos
│   ├── views.py · urls.py · tests.py
│   ├── templates/simulador/index.html
│   └── static/simulador/
│       ├── css/styles.css · css/resultados.css
│       └── js/app.js · js/resultados.js · js/charts.js · js/icons.js
├── README.md
└── DOCUMENTACION_FLUJO_DE_DATOS.md   recorrido didáctico de la pantalla a SHAP
```

## API

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/variables/` | Catálogo de variables válidas con estadísticas e importancia |
| POST | `/api/predecir/` | Predicción + semáforo + recomendaciones + clima de mañana + explicación sencilla (requiere token CSRF) |
| GET | `/api/resultados/` | Métricas, series observadas y pronosticadas, factores globales y días críticos para PM₂.₅ y PM₁₀ |

`/api/resultados/` requiere que los modelos estén disponibles. Calcula la evaluación sobre la partición cronológica de prueba y conserva el resultado en memoria durante la vida del servicio. La interfaz solicita los datos al entrar en la pantalla y permite alternar el contaminante sin repetir la petición.

Ejemplo de cuerpo para `/api/predecir/`:

```json
{"variables": [
  {"variable": "pm2_5", "valor": 24.5, "valor_previo": 17},
  {"variable": "nitrogen_dioxide", "valor": 21}
]}
```

La respuesta incluye el bloque `clima`, con `disponible`, `fecha`, `fuente` y `resumen` (lluvia, viento, temperatura y nubes de mañana).

## Configuración

| Variable de entorno | Valor por defecto | Uso |
|---|---|---|
| `DJANGO_SECRET_KEY` | clave de desarrollo | **Obligatoria en producción** |
| `DJANGO_DEBUG` | `1` | `0` en producción |
| `DJANGO_ALLOWED_HOSTS` | `localhost,127.0.0.1` | Dominios permitidos |
| `AIRE_IMPUTACION` | `iterativa` | `mediana` para imputación simple |
| `AIRE_METEO_EN_LINEA` | `1` | `0` para no consultar Open-Meteo y usar el clima típico del mes |

## Notas

- **Formato de los modelos:** se cargan en el formato nativo de LightGBM (`.txt`), que no depende de la versión de scikit-learn con que se entrenaron.
- **shap es opcional:** si no se instala, la aplicación usa las contribuciones nativas de LightGBM (`pred_contrib=True`), que calculan el mismo TreeSHAP.
- **Reproducción del notebook:** la limpieza, las variables y la unión con la meteorología son las del notebook `E2_Capitulo2`. Se obtienen las mismas 1.294 filas, la partición 906/194/194, los P90 (18,35 / 25,56) y exactamente las métricas de prueba del modelo (MAE 2,4045 / 2,4856).
- **Limitación:** el modelo se entrenó con la meteorología observada (reanálisis ERA5) y en operación recibe un pronóstico, que tiene su propio error. Además, la malla meteorológica (unos 25 km) no resuelve las inversiones térmicas del valle.
- **Conexión a internet:** solo la necesita la descarga del clima. Los gráficos son SVG propios, sin CDN.
