"""
Vistas: una página (la interfaz completa) y cuatro endpoints JSON.

Las vistas son delgadas a propósito: validan el transporte HTTP (método,
tamaño, JSON bien formado) y delegan TODA la lógica al servicio de ML.
"""
import json
import logging

from django.http import JsonResponse
from django.shortcuts import render
from django.urls import reverse
from django.views.decorators.http import require_GET, require_POST

from .ml_service import ErrorValidacion, ModelosNoDisponibles, obtener_servicio

log = logging.getLogger(__name__)


def _error(mensaje: str, estado: int) -> JsonResponse:
    return JsonResponse({"ok": False, "error": mensaje}, status=estado)


@require_GET
def inicio(request):
    """Renderiza la SPA. El catálogo de variables viaja embebido (json_script)
    para que el selector funcione sin una petición adicional."""
    servicio = obtener_servicio()
    contexto = {
        "catalogo": servicio.catalogo_publico(),
        "config_front": {
            "api": {
                "predecir": reverse("simulador:api_predecir"),
                "benchmark": reverse("simulador:api_benchmark"),
                "estado": reverse("simulador:api_estado"),
            },
            "listo": servicio.listo,
            "error_carga": servicio.error_carga,
        },
    }
    return render(request, "simulador/index.html", contexto)


@require_GET
def api_variables(request):
    return JsonResponse({"ok": True, "variables": obtener_servicio().catalogo_publico()})


@require_POST
def api_predecir(request):
    """POST JSON:
        {"variables": [{"variable": "pm2_5", "valor": 25.5, "valor_previo": 18}, ...]}
    Respuesta: predicción, semáforo, recomendaciones y explicación SHAP.
    """
    if request.content_type != "application/json":
        return _error("Envía el cuerpo como application/json.", 415)
    try:
        payload = json.loads(request.body.decode("utf-8") or "{}")
    except (UnicodeDecodeError, json.JSONDecodeError):
        return _error("El cuerpo no es un JSON válido.", 400)
    try:
        return JsonResponse(obtener_servicio().predecir(payload))
    except ErrorValidacion as e:
        return _error(str(e), 400)
    except ModelosNoDisponibles as e:
        return _error(str(e), 503)
    except Exception:  # noqa: BLE001 - nunca exponer trazas al usuario
        log.exception("Fallo inesperado en la predicción")
        return _error("Ocurrió un error interno al calcular la predicción.", 500)


@require_GET
def api_benchmark(request):
    return JsonResponse({"ok": True, **obtener_servicio().benchmark()})


@require_GET
def api_estado(request):
    return JsonResponse({"ok": True, **obtener_servicio().estado()})
