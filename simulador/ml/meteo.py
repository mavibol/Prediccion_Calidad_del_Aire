"""
Meteorología para el escenario C (pronóstico a 24 h + meteorología).

El modelo necesita el tiempo de MAÑANA (día pronosticado) y el de HOY (rezago de un día).
Se descargan del pronóstico de Open-Meteo y se agregan a valores diarios exactamente como en
la sección 12 del notebook del EDA (mismos nombres de columna).
"""
from __future__ import annotations

import json
import urllib.parse
import urllib.request

import numpy as np
import pandas as pd

URL_PRONOSTICO = "https://api.open-meteo.com/v1/forecast"
ZONA_HORARIA = "America/Bogota"
VARIABLES_HORARIAS = ["temperature_2m", "relative_humidity_2m", "precipitation", "wind_speed_10m",
                      "wind_direction_10m", "shortwave_radiation", "cloud_cover", "surface_pressure",
                      "boundary_layer_height"]

# Las 15 variables diarias, en el mismo orden del notebook
COLS_METEO = ["temp_media", "temp_max", "temp_min", "humedad_media", "precipitacion_sum",
              "viento_vel_media", "viento_vel_max", "viento_u_media", "viento_v_media", "radiacion_sum",
              "nubosidad_media", "presion_media", "capa_limite_media", "capa_limite_min", "amplitud_termica"]


def es_meteo(columna: str) -> bool:
    """'precipitacion_sum' y 'precipitacion_sum_lag1' son meteorológicas."""
    base = columna[:-5] if columna.endswith("_lag1") else columna
    return base in COLS_METEO


def agregar_diario(horario: pd.DataFrame) -> pd.DataFrame:
    """Celda 12.3 del notebook del EDA: de datos horarios a valores diarios."""
    h = horario.copy()
    h["time"] = pd.to_datetime(h["time"])
    h["date"] = h["time"].dt.floor("D")
    rad = np.deg2rad(h["wind_direction_10m"])
    h["viento_u"] = -h["wind_speed_10m"] * np.sin(rad)
    h["viento_v"] = -h["wind_speed_10m"] * np.cos(rad)
    agregaciones = {
        "temp_media": ("temperature_2m", "mean"), "temp_max": ("temperature_2m", "max"),
        "temp_min": ("temperature_2m", "min"), "humedad_media": ("relative_humidity_2m", "mean"),
        "precipitacion_sum": ("precipitation", "sum"), "viento_vel_media": ("wind_speed_10m", "mean"),
        "viento_vel_max": ("wind_speed_10m", "max"), "viento_u_media": ("viento_u", "mean"),
        "viento_v_media": ("viento_v", "mean"), "radiacion_sum": ("shortwave_radiation", "sum"),
        "nubosidad_media": ("cloud_cover", "mean"), "presion_media": ("surface_pressure", "mean"),
    }
    if "boundary_layer_height" in h.columns and h["boundary_layer_height"].notna().any():
        agregaciones["capa_limite_media"] = ("boundary_layer_height", "mean")
        agregaciones["capa_limite_min"] = ("boundary_layer_height", "min")
    d = h.groupby("date").agg(**agregaciones).reset_index()
    d["amplitud_termica"] = d["temp_max"] - d["temp_min"]
    return d


def _get_json(url: str, params: dict, timeout: float = 8) -> dict:
    req = urllib.request.Request(f"{url}?{urllib.parse.urlencode(params)}",
                                 headers={"User-Agent": "aire-claro-tesis/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def descargar_hoy_y_manana(lat: float, lon: float) -> tuple[dict, dict, str]:
    """Devuelve (meteorología de hoy, meteorología de mañana, fecha de mañana 'AAAA-MM-DD').

    Lanza una excepción si no hay conexión o el servicio no responde.
    Si el servicio no ofrece la capa límite, esas dos columnas quedan como NaN y el
    servicio las completa con el promedio histórico del mes.
    """
    datos = _get_json(URL_PRONOSTICO, {"latitude": lat, "longitude": lon, "hourly": ",".join(VARIABLES_HORARIAS),
                                       "timezone": ZONA_HORARIA, "forecast_days": 2})
    diario = agregar_diario(pd.DataFrame(datos["hourly"])).sort_values("date").reset_index(drop=True)
    if len(diario) < 2:
        raise ValueError("Open-Meteo no devolvió los dos días")
    hoy, manana = diario.iloc[0], diario.iloc[1]
    a_dict = lambda fila: {c: (float(fila[c]) if c in fila.index and pd.notna(fila[c]) else np.nan)
                           for c in COLS_METEO}
    return a_dict(hoy), a_dict(manana), manana["date"].strftime("%Y-%m-%d")