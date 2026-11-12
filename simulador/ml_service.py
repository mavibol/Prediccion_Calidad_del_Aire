"""
Pipeline de inferencia del simulador «Aire Claro».

Flujo de una predicción (ver DOCUMENTACION_FLUJO_DE_DATOS.md):

  payload JSON ──► validar() ──► imputar() ──► fila de mañana ──► modelo ──► SHAP
  [{variable,      números,      variables     (mes y día de la      predicción  contribución
    valor,         rangos,       ausentes      semana de la fecha    del día     por variable
    valor_previo}] duplicados    estimadas     real de mañana)
                                                        │
                       semáforo + recomendaciones ◄─────┘──► narrativa

El servicio es un *singleton* perezoso: se carga una vez por proceso
(primera petición) y queda en memoria.
"""
from __future__ import annotations

import json
import logging
import math
import threading
import time
from datetime import date, datetime, timedelta, timezone
from dataclasses import dataclass
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from xgboost.core import XGBoostError

from .ml import catalogo as cat
from .ml.datos import (VARIABLES_BASE, cargar_meteo, cargar_y_limpiar, columnas_escenario_a,
                       columnas_escenario_c, construir_features, fila_desde_lecturas,
                       particion_cronologica)
from .ml.meteo import COLS_METEO, descargar_hoy_y_manana, es_meteo
from .ml.explicadores import crear_explicador
from .ml.narrativa import explicacion_simple, fmt

log = logging.getLogger(__name__)

TIENE_PREVIO = {"pm2_5", "pm10", "carbon_monoxide", "nitrogen_dioxide",
                "sulphur_dioxide", "ozone"}   # variables con lag2 en el modelo
HORA_COLOMBIA = timezone(timedelta(hours=-5))   # Colombia no tiene horario de verano

class ErrorValidacion(ValueError):
    """Error de entrada del usuario (se responde con HTTP 400)."""


class ModelosNoDisponibles(RuntimeError):
    """Faltan los archivos .joblib (se responde con HTTP 503)."""


@dataclass
class ModeloObjetivo:
    clave: str             # "pm2_5" | "pm10"
    modelo: object
    columnas: list[str]    # nombres tal como los espera el modelo
    canonicas: list[str]   # nombre canónico de cada columna (mismo orden)
    explicador: object
    archivo: str


# ---------------------------------------------------------------------------
# Resolución de nombres de variables del modelo
# ---------------------------------------------------------------------------
def nombre_canonico(nombre: str) -> str:
    """'NO2_lag1' -> 'nitrogen_dioxide_lag1'; 'month' -> 'mes'."""
    n = nombre.strip().lower().replace(" ", "_")
    if es_meteo(n):                      # escenario C: 'viento_vel_media', 'viento_vel_media_lag1'
        return n
    if n in cat.ALIAS_CALENDARIO:
        return cat.ALIAS_CALENDARIO[n]
    for t in cat.TRANSFORMACIONES:
        if n.endswith("_" + t):
            base = n[: -len(t) - 1]
            if base in cat.ALIAS_VARIABLES:
                return f"{cat.ALIAS_VARIABLES[base]}_{t}"
    raise ValueError(f"No reconozco la variable del modelo '{nombre}'")


def variable_de(canonica: str) -> str:
    """'pm2_5_ma3' -> 'pm2_5'; 'mes' -> 'calendario'."""
    if canonica in ("mes", "dia_semana"):
        return "calendario"
    if es_meteo(canonica):               # 'precipitacion_sum_lag1' -> 'lluvia'
        return cat.CLIMA_DE[canonica[:-5] if canonica.endswith("_lag1") else canonica]
    return canonica.rsplit("_", 1)[0]


def columnas_del_modelo(modelo, dir_modelos: Path) -> list[str]:
    """Lee el orden de variables del propio modelo (o de metadatos de Colab)."""
    for attr in ("feature_names_in_", "feature_name_"):
        cols = getattr(modelo, attr, None)
        if cols is not None and len(cols):
            return [str(c) for c in cols]
    if hasattr(modelo, "get_booster"):
        cols = modelo.get_booster().feature_names
        if cols:
            return list(cols)
    if callable(getattr(modelo, "feature_name", None)):    # lightgbm.Booster (.txt)
        return list(modelo.feature_name())
    meta = dir_modelos / "metadatos_modelos.json"
    if meta.exists():
        datos = json.loads(meta.read_text(encoding="utf-8"))
        for k in ("features", "variables", "columnas", "feature_names"):
            if isinstance(datos.get(k), list):
                return datos[k]
    log.warning("El modelo no trae nombres de columnas; se asume el orden canónico.")
    return columnas_escenario_a()


def _num(x):
    """Convierte '12,5' o '12.5' o 12.5 en float; vacío -> None."""
    if x is None:
        return None
    if isinstance(x, (int, float)):
        val = float(x)
    else:
        s = str(x).strip().replace(" ", "")
        if s == "":
            return None
        if "," in s and "." in s:
            s = s.replace(".", "").replace(",", ".")
        else:
            s = s.replace(",", ".")
        try:
            val = float(s)
        except ValueError as e:
            raise ErrorValidacion(f"'{x}' no es un número válido.") from e
    if not math.isfinite(val):
        raise ErrorValidacion("Los valores deben ser números finitos.")
    return val


def nivel_ica(contaminante: str, valor: float) -> dict:
    """Ubica una concentración 24 h en el semáforo de 5 niveles (Res. 2254/2017)."""
    v = int(math.floor(valor + 0.5))
    for i, corte in enumerate(cat.CORTES_ICA[contaminante]):
        if v <= corte:
            return cat.NIVELES[i]
    return cat.NIVELES[4]


# ---------------------------------------------------------------------------
# Servicio
# ---------------------------------------------------------------------------
class ServicioML:
    def __init__(self, dir_modelos: Path, ruta_csv: Path, imputacion: str = "iterativa",
                 ruta_meteo: Path | None = None, meteo_en_linea: bool = True):
        self.dir_modelos = Path(dir_modelos)
        self.ruta_csv = Path(ruta_csv)
        self.ruta_meteo = Path(ruta_meteo) if ruta_meteo else None
        self.meteo_en_linea = meteo_en_linea
        self.metodo_imputacion = imputacion
        self.objetivos: dict[str, ModeloObjetivo] = {}
        self.error_carga: str | None = None
        self.usa_meteo = False
        self._cache_meteo = None                 # (instante, resultado) del último pronóstico del clima
        meta = self.dir_modelos / "metadatos_modelos.json"
        ubic = json.loads(meta.read_text(encoding="utf-8")).get("ubicacion", {}) if meta.exists() else {}
        self.ubicacion = (ubic.get("latitud", 6.2518), ubic.get("longitud", -75.5636))
        self._cargar_datos()
        try:
            self._cargar_modelos()
        except ModelosNoDisponibles as e:
            self.error_carga = str(e)
            log.warning(self.error_carga)
        except XGBoostError as e:
            self.objetivos.clear()
            self.error_carga = (
                "XGBoost no pudo usar los modelos guardados. La interfaz se abrirá, "
                "pero las predicciones no estarán disponibles hasta corregir los modelos. "
                f"Detalle: {e}"
            )
            log.exception("No se pudieron cargar o evaluar los modelos XGBoost")

    # ---- 1. Datos de referencia (no dependen del modelo) -----------------
    def _cargar_datos(self):
        df = cargar_y_limpiar(self.ruta_csv)
        self.meteo = None
        if self.ruta_meteo is not None and self.ruta_meteo.exists():
            self.meteo = cargar_meteo(self.ruta_meteo)
        mat = construir_features(df, self.meteo)
        self.train, _, _ = particion_cronologica(mat)
        dias_train = df.loc[self.train.index.min() - pd.Timedelta(days=2):self.train.index.max()]
        self.dias_train = dias_train[VARIABLES_BASE]
        self.stats = {}
        for v in VARIABLES_BASE:
            s = df[v]
            self.stats[v] = {
                "min": float(s.min()), "max": float(s.max()),
                "mediana": float(self.dias_train[v].median()),
                "p10": float(s.quantile(.10)), "p90": float(s.quantile(.90)),
            }
        self.p90 = {"pm2_5": float(self.train["y_pm2_5"].quantile(.9)),
                        "pm10": float(self.train["y_pm10"].quantile(.9))}
        if self.meteo is not None:
            # Respaldo sin internet: promedio histórico de cada variable meteorológica por mes
            self.clima_mes = {int(m): g.mean().to_dict()
                              for m, g in self.meteo.groupby(self.meteo.index.month)}
            for g, meta in cat.CLIMA.items():      # "lo normal" de cada factor de clima
                s = self.meteo[meta["columna"]]
                self.stats[g] = {"min": float(s.min()), "max": float(s.max()), "mediana": float(s.median()),
                        "p10": float(s.quantile(.10)), "p90": float(s.quantile(.90))}
        self._ajustar_imputador()

    def _ajustar_imputador(self):
        """Imputación preentrenada con los días de ENTRENAMIENTO (sin fuga).

        'iterativa': IterativeImputer (regresión bayesiana encadenada). Si el
        usuario da PM2.5 = 30, el PM10 ausente se estima coherente (~38), no
        con la mediana (~17).
        'mediana': valor típico de cada variable.
        """
        self.imputador = None
        if self.metodo_imputacion == "iterativa":
            from sklearn.experimental import enable_iterative_imputer  # noqa: F401
            from sklearn.impute import IterativeImputer
            X = self.dias_train.to_numpy()
            self.imputador = IterativeImputer(
                max_iter=15, random_state=0,
                min_value=X.min(axis=0), max_value=X.max(axis=0),
            ).fit(X)

    # ---- 2. Modelos y explicadores ----------------------------------------
    def _cargar_modelos(self):
        faltan = [
            conf["archivo"] for conf in cat.OBJETIVOS.values()
            if not (self.dir_modelos / conf["archivo"]).exists()
        ]
        if faltan:
            raise ModelosNoDisponibles(
                "Faltan los modelos " + ", ".join(faltan) + f" en {self.dir_modelos}. "
                "Copia los modelos exportados en la sección 11 del notebook E2_Capitulo2 "
                "(modelo_pm2_5.txt, modelo_pm10.txt y metadatos_modelos.json).")
        for clave, conf in cat.OBJETIVOS.items():
            ruta = self.dir_modelos / conf["archivo"]
            if ruta.suffix == ".txt":                 # LightGBM en formato nativo
                import lightgbm as lgb
                modelo = lgb.Booster(model_file=str(ruta))
            elif ruta.suffix == ".json":              # XGBoost en formato nativo
                import xgboost as xgb
                modelo = xgb.XGBRegressor()
                modelo.load_model(ruta)
            else:
                modelo = joblib.load(ruta)
            archivo_modelo = ruta.name
            columnas = columnas_del_modelo(modelo, self.dir_modelos)
            canonicas = [nombre_canonico(c) for c in columnas]
            self.usa_meteo = any(es_meteo(c) for c in canonicas)
            escenario = "C" if self.usa_meteo else "A"
            esperadas = set(columnas_escenario_c() if self.usa_meteo else columnas_escenario_a())
            if set(canonicas) != esperadas:
                raise ModelosNoDisponibles(
                    f"{conf['archivo']}: las variables no coinciden con el escenario {escenario}. "
                    f"Sobran {sorted(set(canonicas) - esperadas)}, "
                    f"faltan {sorted(esperadas - set(canonicas))}.")
            if self.usa_meteo and self.meteo is None:
                raise ModelosNoDisponibles(
                    "El modelo usa variables meteorológicas y falta el archivo "
                    f"{self.ruta_meteo}. Cópialo desde el zip exportado en Colab.")
            self.objetivos[clave] = ModeloObjetivo(
                clave, modelo, columnas, canonicas,
                    crear_explicador(modelo, columnas), archivo_modelo)
        self._importancia_global()

    def _matriz(self, obj: ModeloObjetivo, filas: list[dict]) -> pd.DataFrame:
        """Filas canónicas -> DataFrame con los nombres y el orden del modelo."""
        X = pd.DataFrame(filas)[obj.canonicas]
        X.columns = obj.columnas
        return X.astype(float)

    def _importancia_global(self):
        """|SHAP| medio por variable en una muestra de entrenamiento.

        Ordena el selector de variables según su relevancia para el modelo.
        """
        muestra = self.train.iloc[::6]  # ~150 días repartidos en el periodo
        self.importancia = {}
        for clave, obj in self.objetivos.items():
            X = muestra[obj.canonicas].copy()
            X.columns = obj.columnas
            _, S = obj.explicador.explicar(X.astype(float))
            imp = np.abs(S).mean(axis=0)
            self.importancia[clave] = dict(zip(obj.canonicas, imp.tolist()))

    @property
    def listo(self) -> bool:
        return not self.error_carga and len(self.objetivos) == len(cat.OBJETIVOS)

    # ---- 3. Catálogo para el selector del frontend -----------------------
    def catalogo_publico(self) -> list[dict]:
        imp_var = {}
        if self.listo:
            for v in VARIABLES_BASE:
                imp_var[v] = sum(val for c, val in self.importancia["pm2_5"].items()
                                 if variable_de(c) == v) + \
                             sum(val for c, val in self.importancia["pm10"].items()
                                 if variable_de(c) == v)
            tope = max(imp_var.values()) or 1.0
        salida = []
        for v, meta in cat.VARIABLES.items():
            st = self.stats[v]
            rel = imp_var.get(v, 0) / tope if imp_var else 0
            salida.append({
                "id": v, **{k: meta[k] for k in ("etiqueta", "nombre_largo", "unidad",
                                                 "descripcion", "umbral_seguro",
                                                 "fuente_umbral", "grupo",
                                                 "max_deslizador",
                                                 "min_valido", "max_valido")},
                "tiene_previo": v in TIENE_PREVIO,
                **{f"simple_{k}": cat.SENCILLO[v][k] for k in ("nombre", "icono", "que_es")},
                "mediana": round(st["mediana"], 3), "min": round(st["min"], 3),
                "max": round(st["max"], 3), "p10": round(st["p10"], 3),
                "p90": round(st["p90"], 3),
                "importancia": round(rel, 3),
                "estrellas": 3 if rel >= .5 else 2 if rel >= .2 else 1,
            })
        return sorted(salida, key=lambda d: -d["importancia"])

    # ---- 4. Validación del payload dinámico --------------------------------
    def validar(self, payload) -> tuple[dict, dict, list[str]]:
        """Acepta {"variables": [{"variable", "valor", "valor_previo"}...]}
        o el atajo {"pm2_5": 30, ...}. Devuelve (actual, previo, avisos)."""
        if not isinstance(payload, dict):
            raise ErrorValidacion("El cuerpo debe ser un objeto JSON.")
        items = payload.get("variables")
        if items is None:
            items = [{"variable": k, "valor": v} for k, v in payload.items()]
        if not isinstance(items, list) or not items:
            raise ErrorValidacion("Agrega al menos una variable con su valor.")
        if len(items) > len(VARIABLES_BASE):
            raise ErrorValidacion("Hay más variables de las que existen en el dataset.")
        actual, previo, avisos = {}, {}, []
        for it in items:
            if not isinstance(it, dict):
                raise ErrorValidacion("Cada variable debe ser un objeto {variable, valor}.")
            v = str(it.get("variable", "")).strip()
            if v not in cat.VARIABLES:
                raise ErrorValidacion(f"'{v}' no es una variable válida del dataset.")
            if v in actual:
                raise ErrorValidacion(f"{cat.VARIABLES[v]['etiqueta']} está repetida.")
            meta = cat.VARIABLES[v]
            etq = meta["etiqueta"]
            for campo, destino in (("valor", actual), ("valor_previo", previo)):
                x = _num(it.get(campo))
                if x is None:
                    if campo == "valor":
                        raise ErrorValidacion(f"Falta el valor de {etq}.")
                    continue
                if campo == "valor_previo" and v not in TIENE_PREVIO:
                    continue  # el modelo no usa el día previo de esta variable
                if x < meta["min_valido"] or x > meta["max_valido"]:
                    raise ErrorValidacion(
                        f"{etq} debe estar entre {fmt(meta['min_valido'])} y "
                        f"{fmt(meta['max_valido'])} {meta['unidad']}."
                    )
                destino[v] = x
        return actual, previo, avisos

    # ---- 5. Imputación de variables ausentes ------------------------------
    def imputar(self, actual: dict) -> tuple[dict, dict]:
        """Completa las 9 variables. Devuelve (completo, {var: valor_estimado})."""
        vec = np.array([[actual.get(v, np.nan) for v in VARIABLES_BASE]], dtype=float)
        if self.imputador is not None:
            # El imputador se ajustó dentro del rango histórico; si el usuario
            # entra un valor extremo se recorta SOLO para condicionar la estimación.
            cond = vec.copy()
            for j, v in enumerate(VARIABLES_BASE):
                if not np.isnan(cond[0, j]):
                    cond[0, j] = min(cond[0, j], self.stats[v]["max"])
            lleno = self.imputador.transform(cond)[0]
        else:
            lleno = np.array([self.stats[v]["mediana"] for v in VARIABLES_BASE])
        completo, estimadas = {}, {}
        for j, v in enumerate(VARIABLES_BASE):
            if v in actual:
                completo[v] = actual[v]
            else:
                completo[v] = float(lleno[j])
                estimadas[v] = completo[v]
        return completo, estimadas

    # ---- 6. Predicción + SHAP ---------------------------------------------
    def predecir(self, payload) -> dict:
        if not self.listo:
            raise ModelosNoDisponibles(self.error_carga or "Modelos no cargados.")
        actual, previo, avisos = self.validar(payload)
        completo, estimadas = self.imputar(actual)

        # Se pronostica el día de mañana, así que el mes y el día de la semana son los de
        # su fecha real: la del pronóstico de Open-Meteo o, sin conexión, la de Colombia.
        # Escenario C: el clima de hoy y de mañana sale del pronóstico de Open-Meteo;
        # sin conexión se usa el promedio histórico del mes de cada día.
        clima = self.clima_hoy_y_manana() if self.usa_meteo else None
        if clima and clima["disponible"]:
            fecha_manana = date.fromisoformat(clima["fecha"])
        else:
            fecha_manana = datetime.now(HORA_COLOMBIA).date() + timedelta(days=1)
        fecha_hoy = fecha_manana - timedelta(days=1)
        m, d = fecha_manana.month, fecha_manana.weekday()   # lunes = 0, igual que en el notebook
        if clima and clima["disponible"]:
            hoy, manana = clima["hoy"], clima["manana"]
        elif clima:
            hoy, manana = self.clima_mes[fecha_hoy.month], self.clima_mes[m]
        else:
            hoy, manana = None, None
        filas = [fila_desde_lecturas(completo, previo, m, d, manana, hoy)]

        fuera = [cat.VARIABLES[v]["etiqueta"] for v, x in actual.items()
                 if x > self.stats[v]["max"]]
        for v, x in previo.items():
            if x > self.stats[v]["max"] and cat.VARIABLES[v]["etiqueta"] not in fuera:
                fuera.append(cat.VARIABLES[v]["etiqueta"])
        if fuera:
            avisos.append("Valores por encima del máximo histórico: "
                          + ", ".join(fuera)
                          + ". La predicción puede ser menos confiable fuera del rango de entrenamiento.")

        
        # Valor de cada variable de clima de mañana que se muestra en la explicación
        valores_clima = ({c: float(np.mean([f[c] for f in filas])) for c in COLS_METEO}
                         if self.usa_meteo else None)

        predicciones, explicaciones = {}, {}
        for clave, obj in self.objetivos.items():
            X = self._matriz(obj, filas)
            pred = float(np.mean(obj.modelo.predict(X)))
            _, S = obj.explicador.explicar(X)
            phi = S.mean(axis=0)

            explicaciones[clave] = self._explicacion(
                obj, clave, pred, phi, completo, estimadas, valores_clima)
            n_ica = nivel_ica(clave, pred)
            predicciones[clave] = {
                "valor": round(pred, 2),
                "nivel": n_ica["id"],
                "orden": n_ica["orden"],
            }

        alerta = self._alerta(predicciones, actual)
        return {
            "ok": True,
            "clima": self._clima_publico(clima),
            "entrada": {
                "ingresadas": [{"variable": v, "etiqueta": cat.VARIABLES[v]["etiqueta"],
                                "valor": x, "valor_previo": previo.get(v),
                                "unidad": cat.VARIABLES[v]["unidad"]}
                               for v, x in actual.items()],
                "estimadas": [{"variable": v, "etiqueta": cat.VARIABLES[v]["etiqueta"],
                               "valor": round(x, 3), "unidad": cat.VARIABLES[v]["unidad"],
                               "metodo": self.metodo_imputacion}
                              for v, x in estimadas.items()],
                "completitud": {
                    "ingresadas": len(actual),
                    "total": len(VARIABLES_BASE),
                    "porcentaje": round(len(actual) / len(VARIABLES_BASE) * 100, 1),
                },
            },
            "predicciones": predicciones,
            "alerta": alerta,
            "recomendaciones": self._recomendaciones(alerta["nivel"]),
            "explicacion": explicaciones,
            "avisos": avisos,
        }

    
    def _explicacion(self, obj, clave, pred, phi, completo, estimadas, valores_clima=None) -> dict:
        por_var = {}
        for col_can, aporte in zip(obj.canonicas, phi):
            var = variable_de(col_can)
            por_var[var] = por_var.get(var, 0.0) + float(aporte)

        contribs = []
        for v in VARIABLES_BASE:
            meta = cat.VARIABLES[v]
            contribs.append({
                "variable": v, "etiqueta": meta["etiqueta"], "unidad": meta["unidad"],
                "valor": round(completo[v], 4),
                "origen": "estimada" if v in estimadas else "ingresada",
                "aporte": round(por_var.get(v, 0.0), 4),
                        })

        for g, meta in cat.CLIMA.items():
            if g in por_var and valores_clima:
                contribs.append({
                    "variable": g, "etiqueta": meta["etiqueta"], "unidad": meta["unidad"],
                    "valor": round(valores_clima[meta["columna"]], 4),
                    "origen": "clima", "aporte": round(por_var[g], 4),
                })

        simple = explicacion_simple(contribs, pred, self.stats, cat.SENCILLO)
        # Para «De un día típico a tu pronóstico»: punto de partida SHAP y aporte del calendario.
        # Se cumple: base + suma de todos los aportes = pronóstico.
        simple["base"] = round(pred - float(np.sum(phi)), 4)
        simple["calendario"] = round(por_var.get("calendario", 0.0), 4)
        return {"simple": simple}

    # ---- 7. Clima de hoy y de mañana (escenario C) -------------------------
    def clima_hoy_y_manana(self) -> dict:
        """Pronóstico del tiempo de hoy y mañana. Se guarda 1 hora en memoria (la interfaz
        recalcula con cada cambio de los deslizadores); si falla, se reintenta a los 10 minutos."""
        ahora = time.monotonic()
        if self._cache_meteo and ahora < self._cache_meteo[0]:
            return self._cache_meteo[1]
        resultado = {"disponible": False}
        if self.meteo_en_linea:
            try:
                hoy, manana, fecha = descargar_hoy_y_manana(*self.ubicacion)
                mes = int(fecha[5:7])
                for c in COLS_METEO:          # p. ej., capa límite no disponible en el pronóstico
                    if np.isnan(hoy[c]):
                        hoy[c] = self.clima_mes[mes][c]
                    if np.isnan(manana[c]):
                        manana[c] = self.clima_mes[mes][c]
                resultado = {"disponible": True, "hoy": hoy, "manana": manana, "fecha": fecha}
            except Exception as e:  # noqa: BLE001 - sin internet o servicio caído
                log.warning("No se pudo descargar el pronóstico del clima: %s", e)
        vigencia = 3600 if resultado["disponible"] else 600
        self._cache_meteo = (ahora + vigencia, resultado)
        return resultado

    @staticmethod
    def _clima_publico(clima: dict | None) -> dict | None:
        """Resumen del clima de mañana para la interfaz."""
        if clima is None:
            return None
        if not clima["disponible"]:
            return {"disponible": False,
                    "fuente": "Sin conexión con el pronóstico del clima: se usó el clima típico del mes."}
        m = clima["manana"]
        return {
            "disponible": True, "fecha": clima["fecha"], "fuente": "Pronóstico del clima de Open-Meteo",
            "resumen": [{"id": g, "nombre": cat.CLIMA[g]["etiqueta"], "icono": cat.SENCILLO[g]["icono"],
                         "valor": round(m[cat.CLIMA[g]["columna"]], 1), "unidad": cat.CLIMA[g]["unidad"]}
                        for g in ("lluvia", "viento", "temperatura", "nubes")],
        }

    def _alerta(self, predicciones: dict, actual: dict) -> dict:
        """Semáforo = el peor entre (a) el pronóstico y (b) tus lecturas actuales de PM.

        (b) es una salvaguarda: si ingresas PM2.5 = 80 µg/m³, el aire YA es dañino
        aunque el modelo (que no extrapola) pronostique menos.
        """
        candidatos = []
        for k, p in predicciones.items():
            candidatos.append((cat.NIVELES[[n["id"] for n in cat.NIVELES].index(p["nivel"])],
                               "pronostico", k, p["valor"]))
        for k in ("pm2_5", "pm10"):
            if k in actual:
                candidatos.append((nivel_ica(k, actual[k]), "lectura_actual", k, actual[k]))
        nivel, fuente, cont, valor = max(candidatos, key=lambda c: (c[0]["orden"], c[1] == "pronostico"))
        etq = cat.OBJETIVOS[cont]["etiqueta"]
        if fuente == "pronostico":
            motivo = (f"Determinado por el pronóstico de {etq} ({fmt(valor)} µg/m³), "
                      f"categoría ICA «{nivel['categoria_ica']}».")
        else:
            motivo = (f"Determinado por tu lectura actual de {etq} ({fmt(valor)} µg/m³), "
                      f"categoría ICA «{nivel['categoria_ica']}»; el pronóstico es menor, "
                      "pero el aire de ahora ya merece esta precaución.")
        criticos = [cat.OBJETIVOS[k]["etiqueta"] for k, p in predicciones.items()
                    if p["valor"] > self.p90[k]]
        return {
            "nivel": nivel["id"], "orden": nivel["orden"], "etiqueta": nivel["etiqueta"],
            "categoria_ica": nivel["categoria_ica"], "color": nivel["color"],
            "tinta": nivel["tinta"], "icono": nivel["icono"], "resumen": nivel["resumen"],
            "fuente": fuente, "contaminante": cont, "motivo": motivo,
            **{k: cat.NIVELES_SENCILLO[nivel["id"]][k] for k in ("cara", "titulo", "frase")},
            "dia_critico_local": bool(criticos),
            "dia_critico_texto": (
                f"Además, el pronóstico de {' y '.join(criticos)} está en el 10 % de los días "
                "más contaminados de la ciudad (umbral P90 de la tesis)." if criticos else None),
        }

    @staticmethod
    def _recomendaciones(nivel_id: str) -> list[dict]:
        recs = cat.RECOMENDACIONES[nivel_id]
        cortas = cat.RECOMENDACIONES_CORTAS[nivel_id]
        return [{**a, "estado": recs[a["id"]][0], "texto": recs[a["id"]][1],
                 "corto": cortas[a["id"]]} for a in cat.ACTIVIDADES]

# Singleton perezoso y seguro para hilos
# ---------------------------------------------------------------------------
_servicio: ServicioML | None = None
_candado = threading.Lock()


def obtener_servicio() -> ServicioML:
    global _servicio
    if _servicio is None:
        with _candado:
            if _servicio is None:
                from django.conf import settings
                _servicio = ServicioML(settings.AIRE_DIR_MODELOS, settings.AIRE_RUTA_CSV,
                                       getattr(settings, "AIRE_IMPUTACION", "iterativa"),
                                       getattr(settings, "AIRE_RUTA_METEO", None),
                                       getattr(settings, "AIRE_METEO_EN_LINEA", True))
    return _servicio


def reiniciar_servicio():
    """Útil en pruebas o tras reemplazar los .joblib."""
    global _servicio
    with _candado:
        _servicio = None
