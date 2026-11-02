"""
Traduce los valores SHAP a frases en lenguaje cotidiano.

Regla de oro: cada frase debe poder verificarse con los números que la
interfaz muestra al lado (valor ingresado, umbral, aporte en µg/m³).
"""
from __future__ import annotations

from .catalogo import VARIABLES


def fmt(x: float, dec: int = 1) -> str:
    """Formato colombiano: coma decimal y punto de miles."""
    s = f"{x:,.{dec}f}"
    return s.replace(",", "_").replace(".", ",").replace("_", ".")


def fmt_signo(x: float, dec: int = 1) -> str:
    return ("+" if x >= 0 else "−") + fmt(abs(x), dec)


def _pct(a: float, b: float) -> float:
    return (a - b) / b * 100.0 if b else 0.0


def _origen_txt(c) -> str:
    return "que ingresaste" if c["origen"] == "ingresada" else "estimado por el sistema"


def _justificar_subida(c) -> str:
    v, u, med, umb = c["valor"], c["unidad"], c["mediana"], c["umbral_seguro"]
    unidad = f" {u}" if u not in ("adim.", "índice") else ""
    if umb is not None and v > umb:
        return (f"el valor {_origen_txt(c)} ({fmt(v)}{unidad}) supera el umbral seguro "
                f"({fmt(umb, 0)}{unidad}, {c['fuente_umbral']}) en un {fmt(_pct(v, umb), 0)} %.")
    if v > med * 1.02:
        return (f"el valor {_origen_txt(c)} ({fmt(v, 2 if v < 10 else 1)}{unidad}) está un "
                f"{fmt(_pct(v, med), 0)} % por encima de lo habitual en la ciudad "
                f"({fmt(med, 2 if med < 10 else 1)}{unidad}).")
    return (f"aunque su valor ({fmt(v, 2 if v < 10 else 1)}{unidad}) no es alto, el modelo "
            "aprendió una relación inversa para esta variable. Tómalo con cautela: puede "
            "reflejar un cambio en la fuente de datos más que un efecto físico.")


def _justificar_bajada(c) -> str:
    v, u, med, umb = c["valor"], c["unidad"], c["mediana"], c["umbral_seguro"]
    unidad = f" {u}" if u not in ("adim.", "índice") else ""
    if v < med * 0.98:
        return (f"su valor ({fmt(v, 2 if v < 10 else 1)}{unidad}) está un "
                f"{fmt(abs(_pct(v, med)), 0)} % por debajo de lo habitual "
                f"({fmt(med, 2 if med < 10 else 1)}{unidad}).")
    if umb is not None and v <= umb:
        return (f"su valor ({fmt(v)}{unidad}) está dentro del umbral seguro "
                f"({fmt(umb, 0)}{unidad}).")
    return ("aunque su valor es alto, el modelo aprendió una relación inversa para esta "
            "variable. Tómalo con cautela: puede reflejar un cambio en la fuente de datos.")


def construir_narrativa(objetivo: str, pred: float, base: float, contribs: list[dict],
                        aporte_calendario: float, fuera_de_rango: list[str]) -> list[dict]:
    frases = []
    dif = pred - base
    if abs(dif) < 0.3:
        comp = f"prácticamente igual a un día típico ({fmt(base)} µg/m³)"
    else:
        comp = (f"{fmt(abs(dif))} µg/m³ {'más' if dif > 0 else 'menos'} que un día típico "
                f"({fmt(base)} µg/m³)")
    frases.append({"tipo": "resumen", "texto":
                   f"Con los datos disponibles, el modelo espera un {objetivo} promedio de "
                   f"{fmt(pred)} µg/m³ para las próximas 24 horas: {comp}."})

    total = sum(abs(c["aporte"]) for c in contribs) + abs(aporte_calendario) or 1.0
    # Solo se narran efectos relevantes: ≥ 0,15 µg/m³ y ≥ 5 % del efecto total.
    minimo = max(0.15, 0.05 * total)
    suben = sorted([c for c in contribs if c["aporte"] >= minimo], key=lambda c: -c["aporte"])
    bajan = sorted([c for c in contribs if c["aporte"] <= -minimo], key=lambda c: c["aporte"])
    if not suben and not bajan:
        frases.append({"tipo": "info", "texto":
                       "Ninguna variable se aleja lo suficiente de lo habitual como para mover "
                       "la predicción de forma apreciable."})

    if suben:
        c = suben[0]
        verbo = "subió principalmente" if dif > 0 else "tuvo un empuje hacia arriba"
        frases.append({"tipo": "sube", "variable": c["variable"], "texto":
                       f"El nivel {verbo} por {c['etiqueta']}: {_justificar_subida(c)} "
                       f"Eso empujó la predicción {fmt_signo(c['aporte'])} µg/m³ "
                       f"({fmt(abs(c['aporte']) / total * 100, 0)} % del efecto total)."})
        if len(suben) > 1 and suben[1]["aporte"] > 0.25 * c["aporte"]:
            c2 = suben[1]
            frases.append({"tipo": "sube", "variable": c2["variable"], "texto":
                           f"También sumó {c2['etiqueta']} ({fmt_signo(c2['aporte'])} µg/m³)."})
    if bajan:
        c = bajan[0]
        frases.append({"tipo": "baja", "variable": c["variable"], "texto":
                       f"En cambio, {c['etiqueta']} ayudó a bajarlo "
                       f"({fmt_signo(c['aporte'])} µg/m³) porque {_justificar_bajada(c)}"})

    top = sorted(contribs, key=lambda c: -abs(c["aporte"]))[:3]
    estimadas = [c["etiqueta"] for c in top if c["origen"] == "estimada"]
    if estimadas:
        lista = " y ".join(estimadas) if len(estimadas) <= 2 else \
            ", ".join(estimadas[:-1]) + " y " + estimadas[-1]
        if len(estimadas) == 1:
            texto = (f"Ojo: no ingresaste {lista}, que está entre los factores más influyentes; "
                     "el sistema lo estimó a partir de tus otros datos. Si lo conoces, "
                     "agrégalo para afinar la predicción.")
        else:
            texto = (f"Ojo: no ingresaste {lista}, que están entre los factores más influyentes; "
                     "el sistema los estimó a partir de tus otros datos. Si los conoces, "
                     "agrégalos para afinar la predicción.")
        frases.append({"tipo": "aviso", "texto": texto})

    if abs(aporte_calendario) >= 0.05:
        frases.append({"tipo": "info", "texto":
                       "Como la simulación no depende de la fecha, el resultado promedia todas "
                       f"las épocas del año (efecto del calendario: {fmt_signo(aporte_calendario)} µg/m³)."})
    if fuera_de_rango:
        frases.append({"tipo": "aviso", "texto":
                       f"Nota: {', '.join(fuera_de_rango)} supera lo observado en la ciudad. "
                       "Los modelos de árboles no extrapolan: más allá del máximo histórico "
                       "el efecto se queda fijo, por eso el semáforo también considera tus "
                       "lecturas actuales."})
    return frases


def explicacion_simple(contribs: list[dict], pred: float, base: float,
                       stats: dict, sencillo: dict, max_por_lado: int = 3) -> dict:
    """Agrupa los mayores aportes SHAP según su dirección respecto al valor base."""
    total = sum(abs(c["aporte"]) for c in contribs) or 1.0
    minimo = max(0.15, 0.05 * total)

    def factor(c):
        s = sencillo[c["variable"]]
        meta = VARIABLES[c["variable"]]
        return {"variable": c["variable"],
                "nombre": f"{meta['etiqueta']} — {meta['nombre_largo']}",
                "nombre_comun": s["nombre"], "icono": s["icono"],
                "que_es": s["que_es"], "etiqueta": c["etiqueta"], "unidad": c["unidad"],
                "valor": c["valor"], "normal": stats[c["variable"]]["mediana"],
                "origen": c["origen"],
                "aporte": c["aporte"]}

    desfavorables = [factor(c) for c in sorted(contribs, key=lambda c: -c["aporte"])
                     if c["aporte"] >= minimo][:max_por_lado]
    favorables = [factor(c) for c in sorted(contribs, key=lambda c: c["aporte"])
                  if c["aporte"] <= -minimo][:max_por_lado]

    dif = pred - base
    if dif > 0.3 and desfavorables:
        frase = "El valor predicho aumenta respecto al valor base."
    elif dif < -0.3 and favorables:
        frase = "El valor predicho disminuye respecto al valor base."
    else:
        frase = "El valor predicho es cercano al valor base."

    return {
        "frase": frase,
        "favorables": favorables,
        "desfavorables": desfavorables,
        "valor_base": round(base, 4),
        "prediccion": round(pred, 4),
        "hay_estimadas": any(f["origen"] == "estimada" for f in desfavorables + favorables),
    }
