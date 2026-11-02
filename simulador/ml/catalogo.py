"""
Catálogo de dominio: variables del dataset, umbrales de referencia,
niveles del semáforo y recomendaciones.

Todo lo que es "conocimiento experto" (no aprendido por el modelo) vive aquí,
para que la tesis pueda citarlo en un solo lugar y sea fácil de auditar.
"""

# ---------------------------------------------------------------------------
# 1. Variables del dataset original (Open-Meteo / CAMS, promedios diarios)
# ---------------------------------------------------------------------------
# Solo se listan las 9 variables que alimentan al modelo. us_aqi y european_aqi
# existen en el CSV pero NO se ofrecen: son índices derivados del propio PM y
# no son predictores del modelo (introducirían fuga de información).
#
# umbral_seguro: guía de la OMS 2021 cuando existe para la variable.
#   PM2.5 24 h = 15 µg/m³ · PM10 24 h = 45 µg/m³ · NO2 24 h = 25 µg/m³
#   SO2 24 h = 40 µg/m³ · CO 24 h = 4 mg/m³ (4000 µg/m³) · O3 8 h = 100 µg/m³
# Para AOD, polvo y UV no hay umbral sanitario: se compara con lo habitual
# (mediana histórica de la ciudad).
# min_valido/max_valido son límites amplios de plausibilidad para evitar errores
# de unidad o entradas imposibles; no son límites regulatorios, rangos de sensor
# ni máximos observados en el dataset.
VARIABLES = {
    "pm2_5": {
        "etiqueta": "PM₂.₅",
        "nombre_largo": "Material particulado fino",
        "unidad": "µg/m³",
        "descripcion": "Partículas menores a 2,5 micras; penetran hasta los alvéolos.",
        "umbral_seguro": 15.0,
        "fuente_umbral": "guía OMS 2021 (24 h)",
        "grupo": "Material particulado",
        "min_valido": 0.0, "max_valido": 5000.0,
    },
    "pm10": {
        "etiqueta": "PM₁₀",
        "nombre_largo": "Material particulado grueso",
        "unidad": "µg/m³",
        "descripcion": "Partículas menores a 10 micras (polvo, hollín, polen).",
        "umbral_seguro": 45.0,
        "fuente_umbral": "guía OMS 2021 (24 h)",
        "grupo": "Material particulado",
        "min_valido": 0.0, "max_valido": 10000.0,
    },
    "carbon_monoxide": {
        "etiqueta": "CO",
        "nombre_largo": "Monóxido de carbono",
        "unidad": "µg/m³",
        "descripcion": "Gas de combustión incompleta (tráfico, quemas).",
        "umbral_seguro": 4000.0,
        "fuente_umbral": "guía OMS 2021 (24 h)",
        "grupo": "Gases",
        "min_valido": 0.0, "max_valido": 100000.0,
    },
    "nitrogen_dioxide": {
        "etiqueta": "NO₂",
        "nombre_largo": "Dióxido de nitrógeno",
        "unidad": "µg/m³",
        "descripcion": "Gas asociado al tráfico vehicular.",
        "umbral_seguro": 25.0,
        "fuente_umbral": "guía OMS 2021 (24 h)",
        "grupo": "Gases",
        "min_valido": 0.0, "max_valido": 20000.0,
    },
    "sulphur_dioxide": {
        "etiqueta": "SO₂",
        "nombre_largo": "Dióxido de azufre",
        "unidad": "µg/m³",
        "descripcion": "Gas de combustibles con azufre (diésel, industria).",
        "umbral_seguro": 40.0,
        "fuente_umbral": "guía OMS 2021 (24 h)",
        "grupo": "Gases",
        "min_valido": 0.0, "max_valido": 100000.0,
    },
    "ozone": {
        "etiqueta": "O₃",
        "nombre_largo": "Ozono troposférico",
        "unidad": "µg/m³",
        "descripcion": "Contaminante secundario que se forma con la luz solar.",
        "umbral_seguro": 100.0,
        "fuente_umbral": "guía OMS 2021 (8 h)",
        "grupo": "Gases",
        "min_valido": 0.0, "max_valido": 5000.0,
    },
    "aerosol_optical_depth": {
        "etiqueta": "AOD",
        "nombre_largo": "Profundidad óptica de aerosoles (AOD)",
        "unidad": "adim.",
        "descripcion": "Qué tanto los aerosoles atenúan la luz en la columna de aire.",
        "umbral_seguro": None,
        "fuente_umbral": None,
        "grupo": "Aerosoles y radiación",
        "min_valido": 0.0, "max_valido": 5.0,
    },
    "dust": {
        "etiqueta": "Polvo",
        "nombre_largo": "Material particulado mineral",
        "unidad": "µg/m³",
        "descripcion": "Polvo transportado (p. ej., episodios del Sahara).",
        "umbral_seguro": None,
        "fuente_umbral": None,
        "grupo": "Aerosoles y radiación",
        "min_valido": 0.0, "max_valido": 100000.0,
    },
    "uv_index": {
        "etiqueta": "Índice UV",
        "nombre_largo": "Índice de radiación ultravioleta",
        "unidad": "índice",
        "descripcion": "Radiación UV; impulsa la química del ozono.",
        "umbral_seguro": None,
        "fuente_umbral": None,
        "grupo": "Aerosoles y radiación",
        "min_valido": 0.0, "max_valido": 50.0,
    },
}

# Alias aceptados al leer nombres de columnas de un modelo exportado desde
# Colab (por si allí se usaron nombres cortos como "NO2_lag1" o "pm25_lag1").
ALIAS_VARIABLES = {
    "pm2_5": "pm2_5", "pm25": "pm2_5", "pm2.5": "pm2_5",
    "pm10": "pm10",
    "carbon_monoxide": "carbon_monoxide", "co": "carbon_monoxide",
    "nitrogen_dioxide": "nitrogen_dioxide", "no2": "nitrogen_dioxide",
    "sulphur_dioxide": "sulphur_dioxide", "so2": "sulphur_dioxide",
    "sulfur_dioxide": "sulphur_dioxide",
    "ozone": "ozone", "o3": "ozone",
    "aerosol_optical_depth": "aerosol_optical_depth", "aod": "aerosol_optical_depth",
    "dust": "dust", "polvo": "dust",
    "uv_index": "uv_index", "uv": "uv_index",
}
ALIAS_CALENDARIO = {
    "mes": "mes", "month": "mes",
    "dia_semana": "dia_semana", "dayofweek": "dia_semana",
    "day_of_week": "dia_semana", "weekday": "dia_semana", "dow": "dia_semana",
}
TRANSFORMACIONES = ("lag1", "lag2", "ma3", "delta")

# Objetivos del escenario A (pronóstico a 24 h)
OBJETIVOS = {
    "pm2_5": {"etiqueta": "PM₂.₅", "archivo": "modelo_pm2_5_XGBoost.joblib"},
    "pm10": {"etiqueta": "PM₁₀", "archivo": "modelo_pm10_XGBoost.joblib"},
}

# ---------------------------------------------------------------------------
# 2. Semáforo de 5 niveles, mapeado del ICA de la Resolución 2254 de 2017
# ---------------------------------------------------------------------------
# Cortes de concentración promedio 24 h (µg/m³). El valor se redondea a entero
# antes de comparar, como en la tabla oficial.
#   PM2.5: Buena 0-12 · Aceptable 13-37 · Dañina sensibles 38-55 ·
#          Dañina 56-150 · Muy dañina 151-250 · Peligrosa 251-500
#   PM10:  Buena 0-54 · Aceptable 55-154 · Dañina sensibles 155-254 ·
#          Dañina 255-354 · Muy dañina 355-424 · Peligrosa 425-604
CORTES_ICA = {
    "pm2_5": [12, 37, 55, 150],
    "pm10": [54, 154, 254, 354],
}

NIVELES = [
    {
        "id": "sin_contaminacion", "orden": 0, "etiqueta": "Sin contaminación",
        "categoria_ica": "Buena", "color": "#0ca30c", "tinta": "#ffffff", "icono": "checkCircle",
        "resumen": "El aire es limpio. Puedes hacer tus actividades con normalidad.",
    },
    {
        "id": "bajo", "orden": 1, "etiqueta": "Bajo",
        "categoria_ica": "Aceptable", "color": "#fab219", "tinta": "#0b0b0b", "icono": "dotCircle",
        "resumen": "Calidad aceptable. Solo personas muy sensibles deberían moderar esfuerzos largos.",
    },
    {
        "id": "moderado", "orden": 2, "etiqueta": "Moderado",
        "categoria_ica": "Dañina para grupos sensibles", "color": "#ec835a", "tinta": "#0b0b0b",
        "icono": "triangleAlert",
        "resumen": "Niños, adultos mayores y personas con asma o enfermedades cardiacas deben reducir la actividad al aire libre.",
    },
    {
        "id": "alto", "orden": 3, "etiqueta": "Alto",
        "categoria_ica": "Dañina para la salud", "color": "#d03b3b", "tinta": "#ffffff", "icono": "shieldAlert",
        "resumen": "Toda la población puede sentir efectos. Evita el ejercicio intenso al aire libre.",
    },
    {
        "id": "critico", "orden": 4, "etiqueta": "Crítico",
        "categoria_ica": "Muy dañina / Peligrosa", "color": "#7d3c98", "tinta": "#ffffff", "icono": "triangleAlert",
        "resumen": "Emergencia sanitaria. Permanece en interiores y sigue las indicaciones de las autoridades.",
    },
]

# ---------------------------------------------------------------------------
# 3. Recomendaciones prácticas por nivel y actividad
#    estado: "si" (adelante) · "precaucion" · "no" (evitar)
# ---------------------------------------------------------------------------
ACTIVIDADES = [
    {"id": "ciclismo", "etiqueta": "Ciclismo", "icono": "bike"},
    {"id": "running", "etiqueta": "Correr", "icono": "run"},
    {"id": "tapabocas", "etiqueta": "Tapabocas", "icono": "mask"},
    {"id": "ventilacion", "etiqueta": "Ventilar espacios", "icono": "window"},
    {"id": "sensibles", "etiqueta": "Niños y grupos sensibles", "icono": "users"},
]

RECOMENDACIONES = {
    "sin_contaminacion": {
        "ciclismo": ("si", "Buen momento para rodar, incluso rutas largas."),
        "running": ("si", "Sin restricciones para entrenar al aire libre."),
        "tapabocas": ("si", "No es necesario por calidad del aire."),
        "ventilacion": ("si", "Abre ventanas y renueva el aire de tu casa u oficina."),
        "sensibles": ("si", "Pueden jugar y hacer actividad al aire libre con normalidad."),
    },
    "bajo": {
        "ciclismo": ("si", "Adelante. Prefiere ciclorrutas alejadas de avenidas con mucho tráfico."),
        "running": ("si", "Puedes correr; si eres muy sensible, evita series intensas junto a vías."),
        "tapabocas": ("si", "No es necesario para la mayoría; opcional si tienes asma."),
        "ventilacion": ("si", "Ventila, idealmente fuera de las horas pico de tráfico."),
        "sensibles": ("precaucion", "Vigila síntomas (tos, falta de aire) en esfuerzos prolongados."),
    },
    "moderado": {
        "ciclismo": ("precaucion", "Reduce la intensidad y la duración; elige rutas con menos tráfico."),
        "running": ("precaucion", "Acorta la sesión o entrena en interiores si notas molestias."),
        "tapabocas": ("precaucion", "Recomendado N95/KN95 para grupos sensibles al aire libre."),
        "ventilacion": ("precaucion", "Ventila poco tiempo y en horas de menor tráfico; un filtro HEPA ayuda."),
        "sensibles": ("no", "Eviten el ejercicio intenso al aire libre; tengan a mano su medicación."),
    },
    "alto": {
        "ciclismo": ("no", "Evita el ciclismo deportivo; si debes desplazarte, usa N95 y trayectos cortos."),
        "running": ("no", "Entrena en interiores hoy."),
        "tapabocas": ("no", "Usa N95/KN95 bien ajustado si sales (toda la población)."),
        "ventilacion": ("no", "Mantén ventanas cerradas en horas pico; usa purificador si tienes."),
        "sensibles": ("no", "Permanezcan en interiores; consulten al médico ante síntomas."),
    },
    "critico": {
        "ciclismo": ("no", "No salgas a rodar."),
        "running": ("no", "Suspende toda actividad física al aire libre."),
        "tapabocas": ("no", "N95/KN95 obligatorio si es imprescindible salir."),
        "ventilacion": ("no", "Ventanas cerradas; sella rendijas y usa filtro HEPA."),
        "sensibles": ("no", "Permanezcan en interiores y sigan las indicaciones de las autoridades."),
    },
}

# Grupos pedagógicos para resumir la explicación (coinciden con la tesis)
GRUPOS = {
    "Material particulado": ["pm2_5", "pm10"],
    "Gases": ["carbon_monoxide", "nitrogen_dioxide", "sulphur_dioxide", "ozone"],
    "Aerosoles y radiación": ["aerosol_optical_depth", "dust", "uv_index"],
    "Calendario": ["mes", "dia_semana"],
}

# ---------------------------------------------------------------------------
# 4. Resultados oficiales reportados en la tesis (Capítulo 3, conjunto de prueba)
#    Se muestran en el comparador como referencia fija, junto al benchmark que
#    recalcula scripts/construir_artefactos.py.
# ---------------------------------------------------------------------------
RESULTADOS_TESIS = {
    "particion": {"entrenamiento": 906, "validacion": 194, "prueba": 194},
    "prueba": [
        {"modelo": "Persistencia (t−1)", "pm2_5": {"mae": 3.125, "r2": -0.003},
         "pm10": {"mae": 3.242, "r2": -0.009}},
        {"modelo": "A · Pronóstico 24 h (XGBoost)", "pm2_5": {"mae": 2.432, "r2": 0.339},
         "pm10": {"mae": 2.558, "r2": 0.352}, "desplegado": True},
        {"modelo": "B · Mismo día (LightGBM / XGBoost)", "pm2_5": {"mae": 1.798, "r2": 0.691},
         "pm10": {"mae": 1.742, "r2": 0.696}},
    ],
    "validacion_xgb_a": {"pm2_5": {"mae": 2.74, "r2": 0.26}, "pm10": {"mae": 2.97, "r2": 0.26}},
    "mejora_vs_persistencia": {"pm2_5": 22.2, "pm10": 21.1},
    "criterio": "Ranking compuesto en validación (MAE + RMSE + R²)",
}

# ---------------------------------------------------------------------------
# 5. Lenguaje para el público general (sin jerga técnica)
# ---------------------------------------------------------------------------
# nombre: forma sencilla de nombrarla · icono: clave SVG · que_es: una línea.
SENCILLO = {
    "pm2_5": {"nombre": "Humo y hollín fino", "icono": "particles",
              "que_es": "Partículas tan pequeñas que llegan hasta los pulmones."},
    "pm10": {"nombre": "Polvo en el aire", "icono": "dust",
             "que_es": "Polvo, tierra y polen que flotan en el aire."},
    "carbon_monoxide": {"nombre": "Humo de motores", "icono": "car",
                        "que_es": "Gas que sale de carros, motos y quemas."},
    "nitrogen_dioxide": {"nombre": "Gases del tráfico", "icono": "traffic",
                         "que_es": "Gas que sueltan los carros y buses en las avenidas."},
    "sulphur_dioxide": {"nombre": "Gases de diésel e industria", "icono": "factory",
                        "que_es": "Gas del diésel y de las fábricas."},
    "ozone": {"nombre": "Ozono", "icono": "sun",
              "que_es": "Gas que se forma con el sol; irrita ojos y garganta."},
    "aerosol_optical_depth": {"nombre": "Bruma", "icono": "haze",
                              "que_es": "Qué tan opaco u «empañado» se ve el cielo."},
    "dust": {"nombre": "Polvo del desierto", "icono": "dunes",
             "que_es": "Polvo que llega desde muy lejos, como el Sahara."},
    "uv_index": {"nombre": "Fuerza del sol", "icono": "sun",
                 "que_es": "Radiación del sol; ayuda a que se forme ozono."},
}

# Clave SVG, título y frase de cada nivel del semáforo
NIVELES_SENCILLO = {
    "sin_contaminacion": {"cara": "checkCircle", "titulo": "Aire limpio", "frase": "Puedes salir con tranquilidad."},
    "bajo": {"cara": "dotCircle", "titulo": "Aire aceptable", "frase": "Bien para casi todos."},
    "moderado": {"cara": "triangleAlert", "titulo": "Aire regular", "frase": "Cuidado si eres sensible."},
    "alto": {"cara": "shieldAlert", "titulo": "Aire contaminado", "frase": "Mejor quédate adentro."},
    "critico": {"cara": "triangleAlert", "titulo": "Aire peligroso", "frase": "No salgas si no es necesario."},
}

# Recomendaciones en máximo 6 palabras
RECOMENDACIONES_CORTAS = {
    "sin_contaminacion": {"ciclismo": "¡A rodar!", "running": "Sal a correr",
                          "tapabocas": "No hace falta", "ventilacion": "Abre las ventanas",
                          "sensibles": "Pueden jugar afuera"},
    "bajo": {"ciclismo": "Sí, lejos de avenidas", "running": "Sí, con calma",
             "tapabocas": "No hace falta", "ventilacion": "Ventila fuera de hora pico",
             "sensibles": "Vigila tos o ahogo"},
    "moderado": {"ciclismo": "Rutas cortas y tranquilas", "running": "Mejor bajo techo",
                 "tapabocas": "N95 si eres sensible", "ventilacion": "Ventila poco tiempo",
                 "sensibles": "Eviten esfuerzos afuera"},
    "alto": {"ciclismo": "Hoy no", "running": "Entrena adentro",
             "tapabocas": "Usa N95 al salir", "ventilacion": "Ventanas cerradas",
             "sensibles": "Quédense adentro"},
    "critico": {"ciclismo": "No salgas", "running": "Suspende el ejercicio",
                "tapabocas": "N95 obligatorio", "ventilacion": "Todo cerrado",
                "sensibles": "Quédense adentro"},
}
