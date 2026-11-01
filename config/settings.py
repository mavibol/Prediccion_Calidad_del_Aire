"""
Configuración de Django para «Aire Claro» v3.

Variables de entorno opcionales:
  DJANGO_SECRET_KEY   clave secreta (obligatoria en producción)
  DJANGO_DEBUG        "1" para modo desarrollo (por defecto "1")
  DJANGO_ALLOWED_HOSTS lista separada por comas
  AIRE_IMPUTACION     "iterativa" (por defecto) o "mediana"
"""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "solo-para-desarrollo-cambiar-en-produccion")
DEBUG = os.environ.get("DJANGO_DEBUG", "1") == "1"
ALLOWED_HOSTS = [h for h in os.environ.get("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1").split(",") if h]

INSTALLED_APPS = [
    "django.contrib.staticfiles",
    "simulador",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {"context_processors": ["django.template.context_processors.request"]},
    },
]

WSGI_APPLICATION = "config.wsgi.application"

# La app no guarda datos de usuarios; SQLite solo se usa para las pruebas.
DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": BASE_DIR / "db.sqlite3"}}

LANGUAGE_CODE = "es-co"
TIME_ZONE = "America/Bogota"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# El frontend lee el token CSRF desde una etiqueta <meta>, no desde la cookie.
CSRF_COOKIE_HTTPONLY = True
DATA_UPLOAD_MAX_MEMORY_SIZE = 64 * 1024

# --- Configuración del modelo -------------------------------------------------
AIRE_DIR_MODELOS = BASE_DIR / "ml_models"
AIRE_RUTA_CSV = BASE_DIR / "datos" / "air_quality_historical.csv"
AIRE_IMPUTACION = os.environ.get("AIRE_IMPUTACION", "iterativa")

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {"console": {"class": "logging.StreamHandler"}},
    "loggers": {"simulador": {"handlers": ["console"], "level": "INFO"}},
}
