"""
Explicadores SHAP con respaldo en cascada.

Orden de preferencia:
  1. shap.TreeExplainer          (la librería usada en la tesis)
  2. Contribuciones nativas      (XGBoost pred_contribs / LightGBM pred_contrib),
                                  que implementan el mismo algoritmo TreeSHAP en C++
  3. TreeSHAP propio en Python   (para árboles de scikit-learn: RandomForest,
                                  GradientBoosting, DecisionTree)

Las tres vías calculan los valores SHAP "path-dependent" (Lundberg et al., 2018),
así que cumplen la propiedad aditiva:
        predicción = valor_base + Σ contribuciones
El servicio usa esa propiedad para resumir los aportes por variable.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


class ExplicadorBase:
    nombre = "base"

    def __init__(self, modelo, columnas):
        self.modelo = modelo
        self.columnas = list(columnas)

    def explicar(self, X: pd.DataFrame):
        """Devuelve (valor_base: float, matriz_shap: ndarray n x p)."""
        raise NotImplementedError


# ---------------------------------------------------------------------------
# 1. Librería shap
# ---------------------------------------------------------------------------
class ExplicadorShap(ExplicadorBase):
    nombre = "shap.TreeExplainer"

    def __init__(self, modelo, columnas):
        super().__init__(modelo, columnas)
        import shap  # noqa: import diferido: puede no estar instalado
        self._exp = shap.TreeExplainer(modelo)

    def explicar(self, X):
        valores = np.asarray(self._exp.shap_values(X[self.columnas]))
        base = float(np.ravel(self._exp.expected_value)[0])
        return base, valores.reshape(len(X), -1)


# ---------------------------------------------------------------------------
# 2. Contribuciones nativas de XGBoost / LightGBM
# ---------------------------------------------------------------------------
class ExplicadorNativo(ExplicadorBase):
    nombre = "contribuciones nativas"

    def __init__(self, modelo, columnas):
        super().__init__(modelo, columnas)
        tipo = type(modelo).__module__
        if tipo.startswith("xgboost"):
            self._tipo = "xgboost"
            self.nombre = "XGBoost pred_contribs (TreeSHAP)"
        elif tipo.startswith("lightgbm"):
            self._tipo = "lightgbm"
            self.nombre = "LightGBM pred_contrib (TreeSHAP)"
        else:
            raise TypeError("Modelo sin contribuciones nativas")

    def explicar(self, X):
        X = X[self.columnas]
        if self._tipo == "xgboost":
            import xgboost as xgb
            dm = xgb.DMatrix(X, feature_names=self.columnas)
            contrib = self.modelo.get_booster().predict(dm, pred_contribs=True)
        else:
            contrib = self.modelo.predict(X, pred_contrib=True)
        contrib = np.asarray(contrib)
        return float(contrib[0, -1]), contrib[:, :-1]


# ---------------------------------------------------------------------------
# 3. TreeSHAP propio para árboles de scikit-learn
# ---------------------------------------------------------------------------
class _ArbolPlano:
    """Arreglos de un árbol de sklearn con la escala ya aplicada a las hojas."""

    def __init__(self, tree, escala=1.0):
        self.izq = tree.children_left
        self.der = tree.children_right
        self.var = tree.feature
        self.umbral = tree.threshold
        self.valor = tree.value[:, 0, 0] * escala
        self.cobertura = tree.weighted_n_node_samples.astype(float)

    def esperado(self):
        hojas = self.izq == -1
        return float(np.sum(self.valor[hojas] * self.cobertura[hojas]) / self.cobertura[0])


def _extender(ruta, prof, z, o, i):
    ruta[prof] = [i, z, o, 1.0 if prof == 0 else 0.0]
    for k in range(prof - 1, -1, -1):
        ruta[k + 1][3] += o * ruta[k][3] * (k + 1) / (prof + 1)
        ruta[k][3] = z * ruta[k][3] * (prof - k) / (prof + 1)


def _desenrollar(ruta, prof, idx):
    o, z = ruta[idx][2], ruta[idx][1]
    siguiente = ruta[prof][3]
    for k in range(prof - 1, -1, -1):
        if o != 0:
            t = ruta[k][3]
            ruta[k][3] = siguiente * (prof + 1) / ((k + 1) * o)
            siguiente = t - ruta[k][3] * z * (prof - k) / (prof + 1)
        else:
            ruta[k][3] = ruta[k][3] * (prof + 1) / (z * (prof - k))
    for k in range(idx, prof):
        ruta[k][0], ruta[k][1], ruta[k][2] = ruta[k + 1][0], ruta[k + 1][1], ruta[k + 1][2]


def _suma_desenrollada(ruta, prof, idx):
    o, z = ruta[idx][2], ruta[idx][1]
    siguiente = ruta[prof][3]
    total = 0.0
    for k in range(prof - 1, -1, -1):
        if o != 0:
            t = siguiente * (prof + 1) / ((k + 1) * o)
            total += t
            siguiente = ruta[k][3] - t * z * (prof - k) / (prof + 1)
        else:
            total += (ruta[k][3] / z) / ((prof - k) / (prof + 1))
    return total


def treeshap_arbol(arbol: _ArbolPlano, x: np.ndarray, phi: np.ndarray):
    """Algoritmo 2 de Lundberg et al. (2018): TreeSHAP exacto, O(T·L·D²)."""
    x32 = x.astype(np.float32)  # sklearn compara en float32

    def recursion(nodo, ruta, prof, z_padre, o_padre, var_padre):
        ruta = [r[:] for r in ruta] + [[0, 0.0, 0.0, 0.0]]
        _extender(ruta, prof, z_padre, o_padre, var_padre)
        if arbol.izq[nodo] == -1:  # hoja
            for i in range(1, prof + 1):
                w = _suma_desenrollada(ruta, prof, i)
                phi[ruta[i][0]] += w * (ruta[i][2] - ruta[i][1]) * arbol.valor[nodo]
            return
        v = arbol.var[nodo]
        caliente = arbol.izq[nodo] if x32[v] <= arbol.umbral[nodo] else arbol.der[nodo]
        frio = arbol.der[nodo] if caliente == arbol.izq[nodo] else arbol.izq[nodo]
        cob = arbol.cobertura[nodo]
        z_in, o_in = 1.0, 1.0
        idx = next((k for k in range(prof + 1) if ruta[k][0] == v), None)
        if idx is not None:
            z_in, o_in = ruta[idx][1], ruta[idx][2]
            _desenrollar(ruta, prof, idx)
            ruta = ruta[:-1]
            prof -= 1
        recursion(caliente, ruta, prof + 1, z_in * arbol.cobertura[caliente] / cob, o_in, v)
        recursion(frio, ruta, prof + 1, z_in * arbol.cobertura[frio] / cob, 0.0, v)

    recursion(0, [], 0, 1.0, 1.0, -1)


class ExplicadorSklearn(ExplicadorBase):
    nombre = "TreeSHAP propio (scikit-learn)"

    def __init__(self, modelo, columnas):
        super().__init__(modelo, columnas)
        from sklearn.ensemble import (GradientBoostingRegressor,
                                      RandomForestRegressor, ExtraTreesRegressor)
        from sklearn.tree import DecisionTreeRegressor
        if isinstance(modelo, GradientBoostingRegressor):
            lr = modelo.learning_rate
            self.arboles = [_ArbolPlano(e[0].tree_, lr) for e in modelo.estimators_]
            init = modelo.init_
            if init == "zero":
                c0 = 0.0
            else:
                c0 = float(np.ravel(init.predict(np.zeros((1, len(columnas)))))[0])
            self.base = c0 + sum(a.esperado() for a in self.arboles)
        elif isinstance(modelo, (RandomForestRegressor, ExtraTreesRegressor)):
            n = len(modelo.estimators_)
            self.arboles = [_ArbolPlano(e.tree_, 1.0 / n) for e in modelo.estimators_]
            self.base = sum(a.esperado() for a in self.arboles)
        elif isinstance(modelo, DecisionTreeRegressor):
            self.arboles = [_ArbolPlano(modelo.tree_)]
            self.base = self.arboles[0].esperado()
        else:
            raise TypeError(f"TreeSHAP propio no soporta {type(modelo).__name__}")

    def explicar(self, X):
        M = X[self.columnas].to_numpy(dtype=float)
        salida = np.zeros_like(M)
        for f, x in enumerate(M):
            for a in self.arboles:
                treeshap_arbol(a, x, salida[f])
        return float(self.base), salida


def crear_explicador(modelo, columnas) -> ExplicadorBase:
    """Intenta cada backend en orden y devuelve el primero que funcione."""
    errores = []
    for clase in (ExplicadorShap, ExplicadorNativo, ExplicadorSklearn):
        try:
            return clase(modelo, columnas)
        except Exception as e:  # noqa: BLE001 - se informa al final
            errores.append(f"{clase.__name__}: {e}")
    raise RuntimeError("No se pudo crear un explicador SHAP:\n" + "\n".join(errores))
