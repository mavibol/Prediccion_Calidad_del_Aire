"""Agrupa las contribuciones SHAP para una explicación accesible."""
from __future__ import annotations

from .catalogo import CLIMA, VARIABLES


def fmt(x: float, dec: int = 1) -> str:
    """Formato colombiano: coma decimal y punto de miles."""
    s = f"{x:,.{dec}f}"
    return s.replace(",", "_").replace(".", ",").replace("_", ".")


def explicacion_simple(contribs: list[dict], pred: float, stats: dict,
                       sencillo: dict) -> dict:
    """Agrupa los aportes SHAP más relevantes por su dirección."""
    total = sum(abs(c["aporte"]) for c in contribs) or 1.0
    minimo = max(0.15, 0.05 * total)

    def factor(c):
        s = sencillo[c["variable"]]
        meta = VARIABLES.get(c["variable"]) or CLIMA[c["variable"]]
        return {"variable": c["variable"],
                "nombre": f"{meta['etiqueta']} — {meta['nombre_largo']}",
                "nombre_comun": s["nombre"], "icono": s["icono"],
                "que_es": s["que_es"], "etiqueta": c["etiqueta"], "unidad": c["unidad"],
                "valor": c["valor"], "normal": stats[c["variable"]]["mediana"],
                "origen": c["origen"],
                "tipo": "clima" if c["variable"] in CLIMA else "aire",
                "aporte": c["aporte"]}

    todos = [factor(c) for c in contribs]
    influyentes = [f for f in todos if abs(f["aporte"]) >= minimo]
    desfavorables = sorted(
        (f for f in influyentes if f["aporte"] > 0),
        key=lambda f: f["aporte"], reverse=True)
    favorables = sorted(
        (f for f in influyentes if f["aporte"] < 0),
        key=lambda f: f["aporte"])

    return {
        "favorables": favorables,
        "desfavorables": desfavorables,
        "factores": sorted(influyentes, key=lambda f: abs(f["aporte"]), reverse=True),
        "contribuciones": sorted(todos, key=lambda f: abs(f["aporte"]), reverse=True),
        "prediccion": round(pred, 4),
        # aporte de TODOS los factores, para comparar PM2.5 y PM10 en la misma tabla
        "aportes": {c["variable"]: round(c["aporte"], 4) for c in contribs},
        "hay_estimadas": any(f["origen"] == "estimada" for f in todos),
    }
