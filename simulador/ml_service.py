"""
Pipeline de inferencia del simulador «Aire Claro».

Flujo de una predicción (ver DOCUMENTACION_FLUJO_DE_DATOS.md):

  payload JSON ──► validar() ──► imputar() ──► construir 84 filas ──► modelo ──► SHAP
  [{variable,      números,      variables     (12 meses × 7 días:     predicción  contribución
    valor,         rangos,       ausentes      la simulación no        promedio    promedio por
    valor_previo}] duplicados    estimadas     depende de la fecha)                variable
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
from dataclasses import dataclass
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from xgboost.core import XGBoostError

from .ml import catalogo as cat
from .ml.datos import (VARIABLES_BASE, cargar_y_limpiar, columnas_escenario_a,
                       construir_features, fila_desde_lecturas, particion_cronologica)
from .ml.explicadores import crear_explicador
from .ml.narrativa import construir_narrativa, explicacion_simple, fmt

log = logging.getLogger(__name__)

TIENE_PREVIO = {"pm2_5", "pm10", "carbon_monoxide", "nitrogen_dioxide",
                "sulphur_dioxide", "ozone"}   # variables con lag2 en el modelo
MESES = range(1, 13)
DIAS = range(7)


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
    def __init__(self, dir_modelos: Path, ruta_csv: Path, imputacion: str = "iterativa"):
        self.dir_modelos = Path(dir_modelos)
        self.ruta_csv = Path(ruta_csv)
        self.metodo_imputacion = imputacion
        self.objetivos: dict[str, ModeloObjetivo] = {}
        self.error_carga: str | None = None
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
        mat = construir_features(df)
        self.train, self.val, self.test = particion_cronologica(mat)
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
            and not (self.dir_modelos / conf["archivo"]).with_suffix(".json").exists()
        ]
        if faltan:
            raise ModelosNoDisponibles(
                "Faltan los modelos " + ", ".join(faltan) + f" en {self.dir_modelos}. "
                "Copia los modelos exportados desde Colab o ejecuta "
                "`python scripts/construir_artefactos.py`.")
        for clave, conf in cat.OBJETIVOS.items():
            ruta = self.dir_modelos / conf["archivo"]
            ruta_nativa = ruta.with_suffix(".json")
            if ruta_nativa.exists():
                import xgboost as xgb
                modelo = xgb.XGBRegressor()
                modelo.load_model(ruta_nativa)
                archivo_modelo = ruta_nativa.name
            else:
                modelo = joblib.load(ruta)
                archivo_modelo = ruta.name
            columnas = columnas_del_modelo(modelo, self.dir_modelos)
            canonicas = [nombre_canonico(c) for c in columnas]
            esperadas = set(columnas_escenario_a())
            if set(canonicas) != esperadas:
                raise ModelosNoDisponibles(
                    f"{conf['archivo']}: las variables no coinciden con el escenario A. "
                    f"Sobran {sorted(set(canonicas) - esperadas)}, "
                    f"faltan {sorted(esperadas - set(canonicas))}.")
            self.objetivos[clave] = ModeloObjetivo(
                clave, modelo, columnas, canonicas,
                    crear_explicador(modelo, columnas), archivo_modelo)
        self._importancia_global()
        self._error_tipico()

    def _matriz(self, obj: ModeloObjetivo, filas: list[dict]) -> pd.DataFrame:
        """Filas canónicas -> DataFrame con los nombres y el orden del modelo."""
        X = pd.DataFrame(filas)[obj.canonicas]
        X.columns = obj.columnas
        return X.astype(float)

    def _importancia_global(self):
        """|SHAP| medio por variable en una muestra de entrenamiento.

        Sirve para dos cosas: ordenar el selector y medir la "cobertura"
        de información que aporta el usuario.
        """
        muestra = self.train.iloc[::6]  # ~150 días repartidos en el periodo
        self.importancia = {}
        for clave, obj in self.objetivos.items():
            X = muestra[obj.canonicas].copy()
            X.columns = obj.columnas
            _, S = obj.explicador.explicar(X.astype(float))
            imp = np.abs(S).mean(axis=0)
            self.importancia[clave] = dict(zip(obj.canonicas, imp.tolist()))

    def _error_tipico(self):
        """Calcula métricas de validación/prueba y calibra un margen P95 en validación."""
        self.mae_prueba, self.rmse_prueba = {}, {}
        self.metricas_validacion, self.margen_p95_validacion = {}, {}
        for clave, obj in self.objetivos.items():
            X_val = self.val[obj.canonicas].copy()
            X_val.columns = obj.columnas
            y_val = self.val[f"y_{clave}"].to_numpy()
            pred_val = obj.modelo.predict(X_val.astype(float))
            errores = np.abs(pred_val - y_val)
            if not len(errores):
                raise ValueError(f"No hay datos de validación para calibrar el error de {clave}.")
            self.metricas_validacion[clave] = {
                "mae": float(mean_absolute_error(y_val, pred_val)),
                "rmse": float(np.sqrt(mean_squared_error(y_val, pred_val))),
                "r2": float(r2_score(y_val, pred_val)),
                "muestras": len(y_val),
            }
            orden = min(len(errores), math.ceil((len(errores) + 1) * 0.95))
            self.margen_p95_validacion[clave] = float(np.sort(errores)[orden - 1])

            X_test = self.test[obj.canonicas].copy()
            X_test.columns = obj.columnas
            y_test = self.test[f"y_{clave}"].to_numpy()
            pred_test = obj.modelo.predict(X_test.astype(float))
            self.mae_prueba[clave] = float(mean_absolute_error(y_test, pred_test))
            self.rmse_prueba[clave] = float(np.sqrt(mean_squared_error(y_test, pred_test)))

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
        t0 = time.perf_counter()
        actual, previo, avisos = self.validar(payload)
        completo, estimadas = self.imputar(actual)

        # La simulación es agnóstica al tiempo: se evalúa el mismo estado del
        # aire en las 84 combinaciones mes × día de la semana y se promedia.
        # Como SHAP es aditivo, el promedio de las explicaciones explica el
        # promedio de las predicciones (la verificación se hace abajo).
        filas = [fila_desde_lecturas(completo, previo, m, d) for m in MESES for d in DIAS]

        fuera = [cat.VARIABLES[v]["etiqueta"] for v, x in actual.items()
                 if x > self.stats[v]["max"]]
        for v, x in previo.items():
            if x > self.stats[v]["max"] and cat.VARIABLES[v]["etiqueta"] not in fuera:
                fuera.append(cat.VARIABLES[v]["etiqueta"])
        if fuera:
            avisos.append("Valores por encima del máximo histórico: "
                          + ", ".join(fuera)
                          + ". La predicción puede ser menos confiable fuera del rango de entrenamiento.")

        predicciones, explicaciones, cobertura = {}, {}, {}
        for clave, obj in self.objetivos.items():
            X = self._matriz(obj, filas)
            pred = float(np.mean(obj.modelo.predict(X)))
            base, S = obj.explicador.explicar(X)
            phi = S.mean(axis=0)
            error_aditivo = abs(base + phi.sum() - pred)

            explicaciones[clave] = self._explicacion(obj, clave, pred, base, phi, completo,
                                                     actual, previo, estimadas, fuera,
                                                     error_aditivo)
            n_ica = nivel_ica(clave, pred)
            margen_p95 = self.margen_p95_validacion[clave]
            predicciones[clave] = {
                "valor": round(pred, 2),
                "error_tipico": round(self.mae_prueba[clave], 2),
                "rmse_prueba": round(self.rmse_prueba[clave], 2),
                "margen_p95": round(margen_p95, 2),
                "intervalo_p95": {
                    "inferior": round(max(0.0, pred - margen_p95), 2),
                    "superior": round(pred + margen_p95, 2),
                    "nivel_nominal": 95,
                    "referencia": "errores absolutos en el conjunto de validación cronológico",
                },
                "valor_base": round(base, 2),
                "nivel": n_ica["id"], "nivel_etiqueta": n_ica["etiqueta"],
                "supera_p90": bool(pred > self.p90[clave]),
                "p90": round(self.p90[clave], 2),
                "umbral_oms": cat.VARIABLES[clave]["umbral_seguro"],
            }
            cobertura[clave] = self._cobertura(obj, clave, actual, previo)

        alerta = self._alerta(predicciones, actual)
        cob_media = float(np.mean(list(cobertura.values())))
        return {
            "ok": True,
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
            "cobertura": {
                "porcentaje": round(cob_media * 100, 1),
                "por_objetivo": {k: round(c * 100, 1) for k, c in cobertura.items()},
                "nivel": "alta" if cob_media >= .75 else "media" if cob_media >= .4 else "baja",
                "puntos": max(1, min(5, math.ceil(cob_media * 5))),
            },
            "predicciones": predicciones,
            "alerta": alerta,
            "recomendaciones": self._recomendaciones(alerta["nivel"]),
            "explicacion": explicaciones,
            "avisos": avisos,
            "tecnico": {
                "algoritmo": {k: type(o.modelo).__name__ for k, o in self.objetivos.items()},
                "explicador": {k: o.explicador.nombre for k, o in self.objetivos.items()},
                "filas_calendario": len(filas),
                "imputacion": "iterativa" if self.imputador is not None else "mediana",
                "latencia_ms": round((time.perf_counter() - t0) * 1000, 1),
            },
        }

    def _explicacion(self, obj, clave, pred, base, phi, completo, actual, previo,
                     estimadas, fuera, error_aditivo) -> dict:
        etq_obj = cat.OBJETIVOS[clave]["etiqueta"]
        detalle, por_var = [], {}
        for col_can, aporte in zip(obj.canonicas, phi):
            var = variable_de(col_can)
            transf = col_can.rsplit("_", 1)[1] if var != "calendario" else col_can
            if var == "calendario":
                origen = "calendario"
            elif var in estimadas:
                origen = "estimada"
            elif transf in ("lag2", "ma3", "delta") and var not in previo:
                origen = "supuesta"   # derivada asumiendo persistencia
            else:
                origen = "ingresada"
            detalle.append({"columna": col_can, "variable": var, "transformacion": transf,
                            "origen": origen, "aporte": round(float(aporte), 4)})
            por_var[var] = por_var.get(var, 0.0) + float(aporte)

        contribs = []
        for v in VARIABLES_BASE:
            meta, st = cat.VARIABLES[v], self.stats[v]
            contribs.append({
                "variable": v, "etiqueta": meta["etiqueta"], "nombre_largo": meta["nombre_largo"],
                "grupo": meta["grupo"], "unidad": meta["unidad"],
                "valor": round(completo[v], 4), "valor_previo": previo.get(v),
                "origen": "estimada" if v in estimadas else "ingresada",
                "mediana": st["mediana"], "umbral_seguro": meta["umbral_seguro"],
                "fuente_umbral": meta["fuente_umbral"],
                "aporte": round(por_var.get(v, 0.0), 4),
            })
        cal = por_var.get("calendario", 0.0)
        total_abs = sum(abs(c["aporte"]) for c in contribs) + abs(cal) or 1.0
        for c in contribs:
            c["porcentaje"] = round(abs(c["aporte"]) / total_abs * 100, 1)
        contribs.sort(key=lambda c: -abs(c["aporte"]))

        grupos = {}
        for c in contribs:
            grupos[c["grupo"]] = grupos.get(c["grupo"], 0.0) + c["aporte"]
        grupos["Calendario"] = cal

        return {
            "objetivo": etq_obj,
            "valor_base": round(base, 3), "prediccion": round(pred, 3),
            "contribuciones": contribs,
            "calendario": {"aporte": round(cal, 4),
                           "porcentaje": round(abs(cal) / total_abs * 100, 1)},
            "grupos": [{"grupo": g, "aporte": round(a, 4)} for g, a in grupos.items()],
            "detalle": sorted(detalle, key=lambda d: -abs(d["aporte"])),
            "narrativa": construir_narrativa(etq_obj, pred, base, contribs, cal, fuera),
            "simple": explicacion_simple(contribs, pred, base, self.stats, cat.SENCILLO),
            "verificacion_aditiva": {
                "base_mas_aportes": round(base + float(np.sum(phi)), 4),
                "prediccion": round(pred, 4), "error": float(f"{error_aditivo:.2e}"),
                "ok": bool(error_aditivo < 1e-3),
            },
        }

    def _cobertura(self, obj, clave, actual, previo) -> float:
        """Fracción de la importancia global que proviene de datos reales del usuario."""
        imp = self.importancia[clave]
        total = sum(val for c, val in imp.items() if variable_de(c) != "calendario") or 1.0
        aportada = 0.0
        for c, val in imp.items():
            var = variable_de(c)
            if var == "calendario" or var not in actual:
                continue
            transf = c.rsplit("_", 1)[1]
            if transf == "lag1" or var in previo:
                aportada += val
        return aportada / total

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
        criticos = [cat.OBJETIVOS[k]["etiqueta"] for k, p in predicciones.items() if p["supera_p90"]]
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

    # ---- 7. Benchmark -----------------------------------------------------
    def benchmark(self) -> dict:
        ruta = self.dir_modelos / "benchmark_modelos.json"
        calculado = json.loads(ruta.read_text(encoding="utf-8")) if ruta.exists() else None
        return {"calculado": calculado, "tesis": cat.RESULTADOS_TESIS,
                "modelo_en_uso": {k: type(o.modelo).__name__ for k, o in self.objetivos.items()},
                "metricas_validacion": getattr(self, "metricas_validacion", {})}

    def estado(self) -> dict:
        return {
            "listo": self.listo, "error": self.error_carga,
            "modelos": {k: {"archivo": o.archivo, "tipo": type(o.modelo).__name__,
                            "explicador": o.explicador.nombre, "variables": len(o.columnas),
                            "metricas_validacion": getattr(self, "metricas_validacion", {}).get(k)}
                        for k, o in self.objetivos.items()},
            "imputacion": self.metodo_imputacion,
            "p90": self.p90,
            "mae_prueba": getattr(self, "mae_prueba", {}),
            "rmse_prueba": getattr(self, "rmse_prueba", {}),
        }


# ---------------------------------------------------------------------------
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
                                       getattr(settings, "AIRE_IMPUTACION", "iterativa"))
    return _servicio


def reiniciar_servicio():
    """Útil en pruebas o tras reemplazar los .joblib."""
    global _servicio
    with _candado:
        _servicio = None
