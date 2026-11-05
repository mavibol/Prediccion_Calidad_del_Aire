# Pronóstico explicable de PM2.5 y PM10 — Valle de Aburrá

Aplicación web en Django del trabajo de grado *Modelo predictivo y explicable de PM2.5 y PM10 en el Valle de Aburrá*. Presenta el pronóstico a 24 horas de PM2.5 y PM10 del escenario principal seleccionado en el Capítulo 2 (**C. Pronóstico 24 h + meteorología**, modelos LightGBM) y sus explicaciones TreeSHAP.

## Páginas

| Ruta | Contenido |
|---|---|
| `/` | Pronóstico para el día siguiente al último dato (o para cualquier fecha histórica), categoría ICA, día crítico, meteorología usada y explicación local TreeSHAP |
| `/historial/` | Métricas en el periodo de prueba frente a la persistencia y series observadas vs. pronosticadas |
| `/explicabilidad/` | Importancia global de variables (TreeSHAP) e importancia por grupos, incluida la meteorología |
| `/acerca/` | Datos, modelo, variables, tabla del ICA (Resolución 2254 de 2017) y limitaciones |

## Estructura

```
dashboard/
├── data/
│   ├── air_quality_historical.csv     ← calidad del aire (Open-Meteo Air Quality API, CAMS)
│   └── meteorologia_diaria.csv        ← meteorología diaria (Open-Meteo, ERA5) exportada por el notebook
├── ml_models/                         ← exportados en la sección 11 del notebook E2_Capitulo2
│   ├── modelo_pm2_5.txt               (LightGBM; .json si fuera XGBoost)
│   ├── modelo_pm10.txt
│   └── metadatos_modelos.json         (escenario, lista de variables, ubicación)
├── services/ml.py                     ← limpieza, variables, predicción y TreeSHAP (igual al notebook)
├── services/meteo.py                  ← descarga y agregación diaria de la meteorología
├── services/actualizacion.py          ← agrega los días nuevos a los archivos de datos
├── services/graficos.py               ← gráficos con matplotlib
├── management/commands/actualizar_datos.py
├── templates/dashboard/  ·  static/dashboard/estilos.css
└── tests.py                           ← pruebas automáticas
```

## Instalación (Windows)

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python manage.py migrate
python manage.py runserver
```

Abrir <http://127.0.0.1:8000/>.

## Modelos

La aplicación lee `metadatos_modelos.json` para saber qué escenario y qué variables usa, y carga los modelos en el formato nativo de cada librería (`.txt` de LightGBM o `.json` de XGBoost), que no depende de la versión de scikit-learn. Si en lugar de C se exporta el escenario A, la aplicación funciona igual sin meteorología.

## Meteorología del día pronosticado

El escenario C necesita el tiempo del día que se pronostica. La aplicación lo obtiene en este orden:

1. Del archivo `meteorologia_diaria.csv`, si ya tiene esa fecha.
2. De Open-Meteo: la **API de pronóstico** si la fecha está entre hace 90 días y los próximos 15, o la **API histórica (ERA5)** si es más antigua.
3. Si no hay conexión, del **promedio histórico del mes**; la página lo advierte porque el pronóstico pierde precisión.

## Actualizar los datos (pronosticar días recientes)

```bash
python manage.py actualizar_datos
```

Descarga de Open-Meteo los días que faltan hasta ayer (calidad del aire y meteorología), con la misma agregación diaria del dataset original. Antes de agregarlos compara los últimos 30 días que ya estaban en el archivo con los descargados: si difieren más de 15 % (por ejemplo, por otras coordenadas), no agrega nada. Guarda una copia `.bak` de cada archivo. Después reinicie el servidor: el pronóstico pasará a ser el de hoy.

## Pruebas

```bash
python manage.py test dashboard
```

Verifican la depuración (1.296 registros), las variables sin fuga de información (21 del escenario A, 51 del C), la unión con la meteorología sin nulos, la agregación diaria, la elección de la API según la fecha, la actualización de datos, las categorías del ICA, que las páginas respondan y la propiedad aditiva de SHAP.

## Notas

- TreeSHAP se calcula con `predict(..., pred_contrib=True)` de LightGBM (o `pred_contribs=True` de XGBoost), el mismo algoritmo exacto de `shap.TreeExplainer`; la aplicación no requiere la librería `shap`.
- Herramienta de apoyo a la decisión: no reemplaza los boletines oficiales del SIATA ni del Área Metropolitana del Valle de Aburrá.
