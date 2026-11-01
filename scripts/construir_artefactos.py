from __future__ import annotations

import argparse
import json
import sys
import time
import warnings
from datetime import datetime
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor, RandomForestRegressor
from sklearn.metrics import f1_score, mean_absolute_error, mean_squared_error, r2_score, recall_score

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))
from simulador.ml.catalogo import OBJETIVOS  # noqa: E402
from simulador.ml.datos import (cargar_y_limpiar, columnas_escenario_a,  # noqa: E402
                                construir_features, particion_cronologica)

warnings.filterwarnings("ignore", category=UserWarning)

HIPERPARAMETROS = {
    # Idénticos a PARAMS del notebook E2_Capitulo2 (Tabla 10 de la tesis)
    "xgboost": dict(learning_rate=0.03, max_depth=4, subsample=0.8, colsample_bytree=0.8,
                    reg_alpha=0.1, reg_lambda=1.0, random_state=42),
    "lightgbm": dict(learning_rate=0.03, max_depth=4, num_leaves=15, subsample=0.8,
                     subsample_freq=1, colsample_bytree=0.8, reg_alpha=0.1, reg_lambda=1.0,
                     random_state=42, verbose=-1),
    "random_forest": dict(n_estimators=300, max_depth=8, min_samples_split=5,
                          min_samples_leaf=2, random_state=42, n_jobs=-1),
    # Sustituto si xgboost no está instalado (solo para pruebas)
    "gbr_sustituto": dict(learning_rate=0.05, max_depth=3, subsample=0.8, random_state=42),
}
MAX_ARBOLES, PACIENCIA = 1000, 50

try:
    import xgboost as xgb
except ImportError:
    xgb = None
try:
    import lightgbm as lgb
except ImportError:
    lgb = None


# ---------------------------------------------------------------------------
# Constructores de candidatos: cada uno devuelve (modelo_entrenado, n_arboles)
# ---------------------------------------------------------------------------
def entrenar_xgboost(Xtr, ytr, Xva, yva, n_fijo=None):
    if xgb is None:
        return entrenar_gbr(Xtr, ytr, Xva, yva, n_fijo)
    hp = HIPERPARAMETROS["xgboost"]
    if n_fijo is None:
        m = xgb.XGBRegressor(n_estimators=MAX_ARBOLES, early_stopping_rounds=PACIENCIA,
                             eval_metric="mae", **hp)
        m.fit(Xtr, ytr, eval_set=[(Xva, yva)], verbose=False)
        n_fijo = int(m.best_iteration) + 1
    m = xgb.XGBRegressor(n_estimators=n_fijo, **hp).fit(Xtr, ytr)
    return m, n_fijo


def entrenar_lightgbm(Xtr, ytr, Xva, yva, n_fijo=None):
    if lgb is None:
        return None, None
    hp = HIPERPARAMETROS["lightgbm"]
    if n_fijo is None:
        m = lgb.LGBMRegressor(n_estimators=MAX_ARBOLES, **hp)
        m.fit(Xtr, ytr, eval_set=[(Xva, yva)], eval_metric="l1",
              callbacks=[lgb.early_stopping(PACIENCIA, verbose=False)])
        n_fijo = int(m.best_iteration_)
    m = lgb.LGBMRegressor(n_estimators=n_fijo, **hp).fit(Xtr, ytr)
    return m, n_fijo


def entrenar_gbr(Xtr, ytr, Xva, yva, n_fijo=None):
    """Sustituto de XGBoost con la misma lógica de parada temprana."""
    hp = HIPERPARAMETROS["gbr_sustituto"]
    if n_fijo is None:
        m = GradientBoostingRegressor(n_estimators=MAX_ARBOLES, **hp).fit(Xtr, ytr)
        errores = [mean_absolute_error(yva, p) for p in m.staged_predict(Xva)]
        mejor, n_fijo = np.inf, 1
        for i, e in enumerate(errores):          # paciencia 50 sobre validación
            if e < mejor:
                mejor, n_fijo = e, i + 1
            elif i + 1 - n_fijo >= PACIENCIA:
                break
    m = GradientBoostingRegressor(n_estimators=n_fijo, **hp).fit(Xtr, ytr)
    return m, n_fijo


def entrenar_rf(Xtr, ytr, *_a, **_k):
    return RandomForestRegressor(**HIPERPARAMETROS["random_forest"]).fit(Xtr, ytr), 300


class Persistencia:
    """Ingenuo: mañana = hoy (t−1)."""
    def __init__(self, col):
        self.col = col
    def fit(self, *_):
        return self
    def predict(self, X):
        return X[self.col].to_numpy()


class MediaMovil(Persistencia):
    """Ingenuo: mañana = promedio de los últimos 3 días."""


class MediaHistorica:
    """Ingenuo: mañana = media del conjunto de entrenamiento."""
    def fit(self, X, y):
        self.media = float(np.mean(y))
        return self
    def predict(self, X):
        return np.full(len(X), self.media)


def metricas(y, p, p90):
    y, p = np.asarray(y), np.asarray(p)
    crit = y > p90
    return {
        "mae": round(float(mean_absolute_error(y, p)), 4),
        "rmse": round(float(np.sqrt(mean_squared_error(y, p))), 4),
        "r2": round(float(r2_score(y, p)), 4),
        "mae_criticos": round(float(mean_absolute_error(y[crit], p[crit])), 4) if crit.any() else None,
        "n_criticos": int(crit.sum()),
        "f1_criticos": round(float(f1_score(crit, p > p90, zero_division=0)), 4),
        "recall_criticos": round(float(recall_score(crit, p > p90, zero_division=0)), 4),
    }


def latencia_ms(modelo, fila, reps=200):
    tiempos = []
    for _ in range(reps):
        t = time.perf_counter()
        modelo.predict(fila)
        tiempos.append((time.perf_counter() - t) * 1000)
    return round(float(np.median(tiempos)), 3)


def estabilidad(constructor, X, y, n_fijo, n_bloques=5, tam=110):
    """Validación cruzada temporal con ventana expansiva (sin mirar el futuro)."""
    maes = []
    n = len(X)
    for b in range(n_bloques):
        fin_tr = n - (n_bloques - b) * tam
        Xtr, ytr = X.iloc[:fin_tr], y.iloc[:fin_tr]
        Xte, yte = X.iloc[fin_tr:fin_tr + tam], y.iloc[fin_tr:fin_tr + tam]
        m, _ = constructor(Xtr, ytr, None, None, n_fijo=n_fijo) if n_fijo else constructor(Xtr, ytr)
        maes.append(round(float(mean_absolute_error(yte, m.predict(Xte))), 4))
    return {"bloques": maes, "media": round(float(np.mean(maes)), 4),
            "desv": round(float(np.std(maes, ddof=1)), 4),
            "cv": round(float(np.std(maes, ddof=1) / np.mean(maes)), 4)}


def ranking(modelos):
    """Ranking compuesto en validación: suma de puestos en MAE, RMSE y R²."""
    def puestos(clave, invertir=False):
        orden = sorted(modelos, key=lambda m: m["validacion"][clave] * (-1 if invertir else 1))
        return {m["id"]: i + 1 for i, m in enumerate(orden)}
    p_mae, p_rmse, p_r2 = puestos("mae"), puestos("rmse"), puestos("r2", invertir=True)
    for m in modelos:
        m["ranking"] = {"mae": p_mae[m["id"]], "rmse": p_rmse[m["id"]], "r2": p_r2[m["id"]]}
        m["ranking"]["total"] = sum(m["ranking"].values())
    return min(modelos, key=lambda m: (m["ranking"]["total"], m["validacion"]["mae"]))["id"]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--reentrenar", action="store_true", help="sobrescribe los .joblib existentes")
    ap.add_argument("--csv", default=str(RAIZ / "datos" / "air_quality_historical.csv"))
    ap.add_argument("--salida", default=str(RAIZ / "ml_models"))
    args = ap.parse_args()
    salida = Path(args.salida)
    salida.mkdir(exist_ok=True)

    mat = construir_features(cargar_y_limpiar(args.csv))
    tr, va, te = particion_cronologica(mat)
    cols = columnas_escenario_a()
    print(f"Matriz {mat.shape} · partición {len(tr)}/{len(va)}/{len(te)}")
    sustituto = xgb is None
    if sustituto:
        print("AVISO: xgboost no está instalado; se usa GradientBoosting de scikit-learn como sustituto.")

    informe = {
        "generado": datetime.now().isoformat(timespec="seconds"),
        "fuente": "scripts/construir_artefactos.py",
        "sustituto": sustituto,
        "versiones": {"python": sys.version.split()[0], "pandas": pd.__version__, "numpy": np.__version__,
                      "xgboost": getattr(xgb, "__version__", None), "lightgbm": getattr(lgb, "__version__", None)},
        "particion": {"entrenamiento": [str(tr.index.min().date()), str(tr.index.max().date()), len(tr)],
                      "validacion": [str(va.index.min().date()), str(va.index.max().date()), len(va)],
                      "prueba": [str(te.index.min().date()), str(te.index.max().date()), len(te)]},
        "hiperparametros": HIPERPARAMETROS,
        "objetivos": {},
    }

    for clave, conf in OBJETIVOS.items():
        y = f"y_{clave}"
        Xtr, ytr, Xva, yva, Xte, yte = tr[cols], tr[y], va[cols], va[y], te[cols], te[y]
        p90 = float(ytr.quantile(0.9))
        Xtv, ytv = pd.concat([Xtr, Xva]), pd.concat([ytr, yva])
        print(f"\n== {conf['etiqueta']} (P90 = {p90:.2f}) ==")

        candidatos = [
            ("persistencia", "Persistencia (t−1)", "Referencia ingenua",
             lambda *a, **k: (Persistencia(f"{clave}_lag1"), None)),
            ("media_movil", "Media móvil 3 días", "Referencia ingenua",
             lambda *a, **k: (MediaMovil(f"{clave}_ma3"), None)),
            ("media_historica", "Media histórica", "Referencia ingenua",
             lambda a, b, *r, **k: (MediaHistorica().fit(a, b), None)),
            ("random_forest", "Random Forest", "Árboles (bagging)", entrenar_rf),
            ("xgboost", "XGBoost" + (" (sustituto GBR)" if sustituto else ""), "Árboles (boosting)", entrenar_xgboost),
        ]
        if lgb is not None:
            candidatos.append(("lightgbm", "LightGBM", "Árboles (boosting)", entrenar_lightgbm))

        resultados, entrenados = [], {}
        for mid, nombre, familia, constructor in candidatos:
            t0 = time.perf_counter()
            modelo, n_arb = constructor(Xtr, ytr, Xva, yva)
            seg = time.perf_counter() - t0
            if modelo is None:
                continue
            entrenados[mid] = modelo
            # Modelo final de prueba: como en la tesis, se evalúa el entrenado en
            # entrenamiento con el número óptimo de árboles.
            r = {"id": mid, "nombre": nombre, "familia": familia, "arboles": n_arb,
                 "segundos_entrenamiento": round(seg, 2),
                 "validacion": metricas(yva, modelo.predict(Xva), p90),
                 "prueba": metricas(yte, modelo.predict(Xte), p90),
                 "latencia_ms": latencia_ms(modelo, Xte.iloc[[0]])}
            if familia == "Referencia ingenua":
                r["estabilidad"] = estabilidad(lambda a, b, c=constructor: c(a, b), Xtv, ytv, None)
            elif mid == "random_forest":
                r["estabilidad"] = estabilidad(lambda a, b: entrenar_rf(a, b), Xtv, ytv, None)
            else:
                r["estabilidad"] = estabilidad(constructor, Xtv, ytv, n_arb)
            resultados.append(r)
            print(f"  {nombre:28s} val MAE {r['validacion']['mae']:.3f} · prueba MAE "
                  f"{r['prueba']['mae']:.3f} R² {r['prueba']['r2']:.3f} · CV ±{r['estabilidad']['desv']:.3f}")

        ganador = ranking([r for r in resultados if r["familia"] != "Referencia ingenua"])
        for r in resultados:
            r["seleccionado"] = r["id"] == ganador
            r["desplegado"] = False

        # Modelo desplegado: el .joblib de ml_models/ (Colab) o el XGBoost entrenado aquí
        ruta = salida / conf["archivo"]
        if ruta.exists() and not args.reentrenar:
            desplegado = joblib.load(ruta)
            print(f"  Se conserva {ruta.name} ({type(desplegado).__name__}).")
            try:
                nombres = list(getattr(desplegado, "feature_names_in_", cols))
                from simulador.ml_service import nombre_canonico
                mapa = {nombre_canonico(n): n for n in nombres}
                Xte_d = Xte.rename(columns={c: mapa[c] for c in cols})[nombres]
                Xva_d = Xva.rename(columns={c: mapa[c] for c in cols})[nombres]
                resultados.append({
                    "id": "desplegado", "nombre": f"{type(desplegado).__name__} (archivo desplegado)",
                    "familia": "Árboles (boosting)", "arboles": None,
                    "validacion": metricas(yva, desplegado.predict(Xva_d), p90),
                    "prueba": metricas(yte, desplegado.predict(Xte_d), p90),
                    "latencia_ms": latencia_ms(desplegado, Xte_d.iloc[[0]]),
                    "estabilidad": None, "seleccionado": False, "desplegado": True})
            except Exception as e:  # noqa: BLE001
                print(f"  No se pudo evaluar el archivo desplegado: {e}")
        else:
            joblib.dump(entrenados["xgboost"], ruta)
            print(f"  Guardado {ruta.name}")
            for r in resultados:
                r["desplegado"] = r["id"] == "xgboost"

        persist = next(r for r in resultados if r["id"] == "persistencia")
        for r in resultados:
            r["mejora_vs_persistencia"] = round(
                (1 - r["prueba"]["mae"] / persist["prueba"]["mae"]) * 100, 1)

        informe["objetivos"][clave] = {"etiqueta": conf["etiqueta"], "p90": round(p90, 2),
                                       "ganador_validacion": ganador, "modelos": resultados}

    (salida / "benchmark_modelos.json").write_text(
        json.dumps(informe, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nListo: {salida / 'benchmark_modelos.json'}")


if __name__ == "__main__":
    main()
