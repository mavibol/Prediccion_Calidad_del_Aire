from django.urls import path

from . import views

app_name = "simulador"

urlpatterns = [
    path("", views.inicio, name="inicio"),
    path("api/variables/", views.api_variables, name="api_variables"),
    path("api/predecir/", views.api_predecir, name="api_predecir"),
    path("api/benchmark/", views.api_benchmark, name="api_benchmark"),
    path("api/estado/", views.api_estado, name="api_estado"),
]
