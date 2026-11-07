"""
Resultados de la evaluación del modelo (objetivo específico 3) para la pantalla «Resultados».

Todo se calcula con los modelos desplegados sobre el periodo de PRUEBA (los 194 días más recientes,
que el modelo nunca vio al entrenarse), con la misma partición cronológica del notebook E2_Capitulo2.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import catalogo as cat
from .datos import cargar_meteo, cargar_y_limpiar, construir_features, particion_cronologica

# Resultados del notebook E2_Capitulo2 (sección 8, conjunto de VALIDACIÓN) que la app no puede
# recalcular porque no despliega todos los modelos. Mejor modelo de cada escenario.
COMPARACION_ESCENARIOS = {
    "pm2_5": {"A": {"mae": 2.741, "r2": 0.262, "modelo": "XGBoost"},
              "C": {"mae": 2.661, "r2": 0.301, "modelo": "LightGBM"}},
    "pm10": {"A": {"mae": 2.969, "r2": 0.258, "modelo": "XGBoost"},
             "C": {"mae": 2.756, "r2": 0.354, "modelo": "LightGBM"}},
}
MODELOS_COMPARADOS = ["XGBoost", "LightGBM", "Random Forest"]

# Grupos para la vista general «¿En qué se fija el modelo?»
GRUPOS_PUBLICOS = [
    ("particulas", "Partículas de días anteriores", {"pm2_5", "pm10"}),
    ("gases", "Otros contaminantes", {"carbon_monoxide", "nitrogen_dioxide", "sulphur_dioxide", "ozone"}),
    ("aerosoles", "Polvo, aerosoles y sol", {"aerosol_optical_depth", "dust", "uv_index"}),
    ("clima", "Clima", set(cat.CLIMA)),
    ("calendario", "Época del año", {"calendario"}),
]

def _fecha(ts) -> str:
    return pd.Timestamp(ts).strftime("%Y-%m-%d")


def _metricas(y: np.ndarray, p: np.ndarray) -> dict:
    e = p - y
    return {"mae": float(np.mean(np.abs(e))), "rmse": float(np.sqrt(np.mean(e ** 2))),
            "r2": float(1 - np.sum(e ** 2) / np.sum((y - y.mean()) ** 2))}


def _nombre_factor(f: str) -> str:
    if f in cat.CLIMA:
        return cat.CLIMA[f]["etiqueta"]
    if f == "calendario":
        return "Época del año"
    return f'{cat.SENCILLO[f]["nombre"]} ({cat.VARIABLES[f]["etiqueta"]})'


def calcular(servicio) -> dict:
    """Resultados por contaminante. Se calcula una vez y se guarda en memoria."""
    if getattr(servicio, "_resultados", None) is not None:
        return servicio._resultados
    from ..ml_service import variable_de        # import diferido (evita import circular)

    df = cargar_y_limpiar(servicio.ruta_csv)
    meteo = cargar_meteo(servicio.ruta_meteo) if getattr(servicio, "usa_meteo", False) else None
    mat = construir_features(df, meteo)
    train, val, test = particion_cronologica(mat)

    salida = {
        "particion": [
            {"id": "entrenamiento", "nombre": "Aprendizaje", "dias": len(train),
             "desde": _fecha(train.index.min()), "hasta": _fecha(train.index.max())},
            {"id": "validacion", "nombre": "Ajuste y selección", "dias": len(val),
             "desde": _fecha(val.index.min()), "hasta": _fecha(val.index.max())},
            {"id": "prueba", "nombre": "Prueba final", "dias": len(test),
             "desde": _fecha(test.index.min()), "hasta": _fecha(test.index.max())},
        ],
        "modelos_comparados": MODELOS_COMPARADOS,
        "contaminantes": {},
    }

    for clave, obj in servicio.objetivos.items():
        X = test[obj.canonicas].copy()
        X.columns = obj.columnas
        y = test[f"y_{clave}"].to_numpy()
        pred = np.asarray(obj.modelo.predict(X), dtype=float)
        pers = test[f"{clave}_lag1"].to_numpy()
        m, mp = _metricas(y, pred), _metricas(y, pers)

        # Días críticos: por encima del P90 de entrenamiento
        umbral = servicio.p90[clave]
        pico = y > umbral
        criticos = {
            "umbral": umbral, "dias": int(pico.sum()),
            "mae": float(np.mean(np.abs(pred[pico] - y[pico]))) if pico.any() else None,
            "mae_persistencia": float(np.mean(np.abs(pers[pico] - y[pico]))) if pico.any() else None,
            "sesgo": float(np.mean(pred[pico] - y[pico])) if pico.any() else None,
        }

        # Importancia SHAP global: |SHAP| medio por variable, sumado por factor público
        _, phi = obj.explicador.explicar(X)
        imp = np.abs(np.asarray(phi)).mean(axis=0)
        por_factor: dict[str, float] = {}
        for canon, valor in zip(obj.canonicas, imp):
            f = variable_de(canon)
            por_factor[f] = por_factor.get(f, 0.0) + float(valor)
        total = sum(por_factor.values()) or 1.0
        factores = sorted(({"id": f, "nombre": _nombre_factor(f), "peso": v / total * 100,
                            "tipo": "clima" if f in cat.CLIMA else "calendario" if f == "calendario" else "aire",
                            "icono": cat.SENCILLO[f]["icono"] if f in cat.SENCILLO else "target"}
                           for f, v in por_factor.items()), key=lambda d: -d["peso"])
        grupos = [{"id": gid, "nombre": nombre,
                   "peso": sum(v for f, v in por_factor.items() if f in miembros) / total * 100}
                  for gid, nombre, miembros in GRUPOS_PUBLICOS]

        salida["contaminantes"][clave] = {
            "etiqueta": cat.OBJETIVOS[clave]["etiqueta"],
            "algoritmo": type(obj.modelo).__module__.split(".")[0].replace("lightgbm", "LightGBM")
                         .replace("xgboost", "XGBoost").replace("sklearn", "scikit-learn"),
            "modelo": m, "persistencia": mp,
            "mejora": (1 - m["mae"] / mp["mae"]) * 100,
            "criticos": criticos,
            "serie": {"fechas": [_fecha(t) for t in test.index], "observado": np.round(y, 2).tolist(),
                      "pronostico": np.round(pred, 2).tolist()},
            "grupos": grupos,
            "factores": factores[:6],
            "escenarios": COMPARACION_ESCENARIOS.get(clave) if getattr(servicio, "usa_meteo", False) else None,
        }

    servicio._resultados = salida
    return salida