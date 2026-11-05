"""
Preparación de datos compartida por la app y por scripts/construir_artefactos.py.

Reproduce la limpieza y la ingeniería de características del Capítulo 2 de la
tesis (escenario A, pronóstico a 24 h). Mantenerla en un solo módulo garantiza
que el simulador construya las 21 variables EXACTAMENTE igual que en el
entrenamiento.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from .catalogo import VARIABLES
from .meteo import COLS_METEO

VARIABLES_BASE = list(VARIABLES.keys())
CONTAMINANTES = ["pm2_5", "pm10", "carbon_monoxide", "nitrogen_dioxide",
                 "sulphur_dioxide", "ozone"]          # lag1 + lag2
AEROSOLES_RAD = ["aerosol_optical_depth", "dust", "uv_index"]  # solo lag1
PM = ["pm2_5", "pm10"]                                         # + ma3 y delta


def columnas_escenario_a() -> list[str]:
    """Orden canónico de las 21 variables del escenario A."""
    cols = []
    for v in CONTAMINANTES:
        cols += [f"{v}_lag1", f"{v}_lag2"]
    cols += [f"{v}_lag1" for v in AEROSOLES_RAD]
    for v in PM:
        cols += [f"{v}_ma3", f"{v}_delta"]
    cols += ["mes", "dia_semana"]
    return cols

def columnas_escenario_c() -> list[str]:
    """Las 51 variables del escenario C: A + meteorología de mañana (t) + meteorología de hoy (t-1)."""
    return columnas_escenario_a() + COLS_METEO + [f"{c}_lag1" for c in COLS_METEO]


def cargar_meteo(ruta_csv: str | Path) -> pd.DataFrame:
    """Meteorología diaria exportada por el notebook (meteorologia_diaria.csv), indexada por fecha."""
    me = pd.read_csv(ruta_csv, parse_dates=["date"]).sort_values("date").set_index("date")
    return me[[c for c in COLS_METEO if c in me.columns]]


def cargar_y_limpiar(ruta_csv: str | Path) -> pd.DataFrame:
    """Limpieza idéntica a la del EDA / Capítulo 2.

    1. Poda de borde: se eliminan 2022-08-01 y 2022-08-02 (sin datos).
    2. AQI nulos del primer día -> bfill (no son predictores).
    3. NO2 = 0 (valor inválido) -> NaN -> interpolación lineal.
    4. UV = 0 el primer día (día incompleto) -> bfill.
    """
    df = pd.read_csv(ruta_csv, parse_dates=["date"]).sort_values("date")
    df = df.dropna(subset=VARIABLES_BASE, how="all").reset_index(drop=True)
    for c in ("us_aqi", "european_aqi"):
        if c in df:
            df[c] = df[c].bfill()
    # Mismas reglas que depurar_datos() del notebook del Capítulo 2
    df.loc[df["nitrogen_dioxide"] == 0, "nitrogen_dioxide"] = np.nan
    df["nitrogen_dioxide"] = df["nitrogen_dioxide"].interpolate(method="linear")
    df.loc[df["uv_index"] == 0, "uv_index"] = np.nan
    df["uv_index"] = df["uv_index"].bfill()
    return df.set_index("date")



def construir_features(df: pd.DataFrame, meteo: pd.DataFrame | None = None) -> pd.DataFrame:    
    
    """Matriz de 21 variables + objetivos (pm2_5, pm10 del día t).

    Supuestos (confirmar contra el notebook):
      * ma3   = media(t-1, t-2, t-3), con mínimo 2 observaciones.
      * delta = (t-1) - (t-2).
      * dia_semana: 0 = lunes (convención de pandas).
    Con estos supuestos se obtienen 1.294 filas (2022-08-05 a 2026-02-18),
    igual que en la tesis.
    """
    out = pd.DataFrame(index=df.index)
    for v in CONTAMINANTES:
        out[f"{v}_lag1"] = df[v].shift(1)
        out[f"{v}_lag2"] = df[v].shift(2)
    for v in AEROSOLES_RAD:
        out[f"{v}_lag1"] = df[v].shift(1)
    for v in PM:
        out[f"{v}_ma3"] = df[v].shift(1).rolling(3, min_periods=2).mean()
        out[f"{v}_delta"] = df[v].shift(1) - df[v].shift(2)
    out["mes"] = df.index.month
    out["dia_semana"] = df.index.dayofweek
    if meteo is not None:
        # Celdas 2.1 y 2.2 del Capítulo 2: unión por fecha (solo días de calidad del aire) y rezago
        m = meteo.reindex(df.index).interpolate(method="linear").bfill().ffill()
        for c in m.columns:
            out[c] = m[c]                       # meteorología del día pronosticado (t)
            out[f"{c}_lag1"] = m[c].shift(1)    # meteorología del día anterior (t-1)
    out["y_pm2_5"] = df["pm2_5"]
    out["y_pm10"] = df["pm10"]
    return out.dropna()


def particion_cronologica(mat: pd.DataFrame, n_val: int = 194, n_test: int = 194):
    """906 / 194 / 194 en orden temporal (sin barajar)."""
    n = len(mat)
    n_train = n - n_val - n_test
    return (mat.iloc[:n_train], mat.iloc[n_train:n_train + n_val],
            mat.iloc[n_train + n_val:])



def fila_desde_lecturas(actual: dict, previo: dict, mes: int, dia: int, meteo_manana: dict | None = None, meteo_hoy: dict | None = None) -> dict:    
    
    """Traduce lecturas "instantáneas" a las 21 variables del modelo.

    `actual[v]` es la lectura más reciente de la variable v  -> v_lag1
    `previo[v]` es la lectura anterior (opcional)            -> v_lag2
    Si falta la lectura previa se asume persistencia (previo = actual),
    lo que da delta = 0 y ma3 = actual: "condiciones sostenidas".
    """
    fila = {}
    for v in CONTAMINANTES:
        a = actual[v]
        p = previo.get(v, a)
        fila[f"{v}_lag1"] = a
        fila[f"{v}_lag2"] = p
    for v in AEROSOLES_RAD:
        fila[f"{v}_lag1"] = actual[v]
    for v in PM:
        a = actual[v]
        p = previo.get(v, a)
        # t-3 desconocido: se asume igual a t-2 (persistencia)
        fila[f"{v}_ma3"] = (a + p + p) / 3.0
        fila[f"{v}_delta"] = a - p
    fila["mes"] = mes
    fila["dia_semana"] = dia
    # Escenario C: el tiempo de mañana entra tal cual y el de hoy como rezago de un día
    for c, x in (meteo_manana or {}).items():
        fila[c] = x
    for c, x in (meteo_hoy or {}).items():
        fila[f"{c}_lag1"] = x
    return fila
