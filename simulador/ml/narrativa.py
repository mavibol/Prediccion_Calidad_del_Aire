"""Agrupa las contribuciones SHAP para una explicación accesible."""
from __future__ import annotations

from .catalogo import CLIMA, VARIABLES


def fmt(x: float, dec: int = 1) -> str:
    """Formato colombiano: coma decimal y punto de miles."""
    s = f"{x:,.{dec}f}"
    return s.replace(",", "_").replace(".", ",").replace("_", ".")


def explicacion_simple(contribs: list[dict], pred: float, stats: dict,
                       sencillo: dict, max_por_lado: int = 3) -> dict:
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

    desfavorables = [factor(c) for c in sorted(contribs, key=lambda c: -c["aporte"])
                     if c["aporte"] >= minimo][:max_por_lado]
    favorables = [factor(c) for c in sorted(contribs, key=lambda c: c["aporte"])
                  if c["aporte"] <= -minimo][:max_por_lado]

    return {
        "favorables": favorables,
        "desfavorables": desfavorables,
        "prediccion": round(pred, 4),
        "hay_estimadas": any(f["origen"] == "estimada" for f in desfavorables + favorables),
    }
