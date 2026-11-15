# Imagen de la aplicación Aire Claro (Django + Gunicorn)
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# LightGBM necesita la librería OpenMP del sistema
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Las dependencias van primero para que Docker las reutilice si solo cambia el código
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

# Usuario sin privilegios; staticfiles se comparte con Nginx mediante un volumen
RUN useradd --system --no-create-home aire \
    && mkdir -p /app/staticfiles \
    && chown -R aire /app/staticfiles
USER aire

EXPOSE 8000

# Al arrancar, copia los estáticos al volumen compartido y levanta Gunicorn
CMD ["sh", "-c", "python manage.py collectstatic --noinput && exec gunicorn config.wsgi:application --bind 0.0.0.0:8000 --workers 2 --timeout 120 --access-logfile - --error-logfile -"]
