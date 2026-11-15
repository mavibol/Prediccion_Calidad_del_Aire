# Despliegue con Docker

La aplicación corre en dos contenedores:

| Contenedor | Qué hace |
|---|---|
| `app` | Django con Gunicorn, los modelos LightGBM y los datos. Se construye con el `Dockerfile` |
| `nginx` | Recibe las visitas en los puertos 80/443, sirve CSS y JS y pasa lo demás a `app` |

Archivos que intervienen: `Dockerfile`, `docker-compose.yml`, `.env` (se crea a partir de `.env.example`) y `deploy/nginx/`.

## Qué pedir del VPS

| Requisito | Por qué |
|---|---|
| Ubuntu 22.04 o 24.04 | Cualquiera sirve: Python viene dentro de la imagen |
| 2 GB de RAM o más | LightGBM, scikit-learn, SHAP y pandas se cargan en memoria |
| Acceso SSH como `root` o usuario con `sudo` | Para instalar Docker |
| Puertos 22, 80 y 443 abiertos | SSH, web y HTTPS |
| Salida a internet hacia `api.open-meteo.com` | Pronóstico del clima de mañana |

## 1. Instalar Docker en el VPS

```bash
ssh root@IP_DEL_VPS
```

```bash
curl -fsSL https://get.docker.com | sh
```

```bash
docker --version && docker compose version
```

## 2. Clonar el repositorio

```bash
git clone https://github.com/mavibol/Prediccion_Calidad_del_Aire.git /srv/aire_claro
```

```bash
cd /srv/aire_claro
```

## 3. Crear el archivo `.env`

```bash
cp .env.example .env
```

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(50))"
```

```bash
nano .env
```

- `DJANGO_SECRET_KEY`: la clave que imprimió el comando anterior.
- `DJANGO_ALLOWED_HOSTS`: la IP del VPS, por ejemplo `203.0.113.10`.
- `DJANGO_CSRF_TRUSTED_ORIGINS`: la misma IP con `http://`, por ejemplo `http://203.0.113.10`.

Guardar con `Ctrl + O`, `Enter`, y salir con `Ctrl + X`.

## 4. Arrancar

```bash
docker compose up -d --build
```

La primera vez tarda unos minutos porque descarga Python e instala las librerías. Luego:

```bash
docker compose ps
```

Los dos contenedores deben aparecer como `running`. Abrir `http://IP_DEL_VPS/` y hacer una predicción.

## 5. Firewall

```bash
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
```

## 6. Dominio y HTTPS (opcional)

Cuando el dominio apunte a la IP del VPS, obtener el certificado (Nginx se detiene un momento para liberar el puerto 80):

```bash
apt-get install -y certbot
```

```bash
docker compose stop nginx
```

```bash
certbot certonly --standalone -d midominio.com -d www.midominio.com \
  --pre-hook "docker compose -f /srv/aire_claro/docker-compose.yml stop nginx" \
  --post-hook "docker compose -f /srv/aire_claro/docker-compose.yml start nginx"
```

Los `hooks` quedan guardados para que la renovación automática de Certbot también funcione. Después, en `.env`:

```
DJANGO_ALLOWED_HOSTS=midominio.com,www.midominio.com,IP_DEL_VPS
DJANGO_CSRF_TRUSTED_ORIGINS=https://midominio.com,https://www.midominio.com
DJANGO_HTTPS=1
NGINX_MODO=https
DOMINIO=midominio.com
```

```bash
docker compose up -d
```

## Operación diaria

| Tarea | Comando (desde `/srv/aire_claro`) |
|---|---|
| Ver estado | `docker compose ps` |
| Ver registros en vivo | `docker compose logs -f` |
| Reiniciar | `docker compose restart` |
| Publicar cambios subidos a GitHub | `git pull && docker compose up -d --build` |
| Aplicar cambios del `.env` | `docker compose up -d` |
| Detener todo | `docker compose down` |
| Liberar espacio de imágenes viejas | `docker image prune -f` |

Para actualizar los datos o los modelos, súbanlos a GitHub (`datos/` y `ml_models/`) y publiquen los cambios con el comando de la tabla.

## Probar en un computador con Docker

En la carpeta del repositorio, crear `.env` a partir de `.env.example` con:

```
DJANGO_ALLOWED_HOSTS=localhost
DJANGO_CSRF_TRUSTED_ORIGINS=http://localhost
```

```bash
docker compose up -d --build
```

Abrir <http://localhost/>.

## Problemas frecuentes

| Síntoma | Causa probable |
|---|---|
| `Bad Request (400)` | La IP o el dominio no están en `DJANGO_ALLOWED_HOSTS` |
| La predicción falla con error 403 | Falta el origen en `DJANGO_CSRF_TRUSTED_ORIGINS` (con `http://` o `https://`) |
| `502 Bad Gateway` | `app` no arrancó: revisar `docker compose logs app` |
| `app` se reinicia sin parar y el registro dice `Defina DJANGO_SECRET_KEY` | Falta la clave en `.env` |
| Nginx no arranca con `NGINX_MODO=https` | El certificado no existe para `DOMINIO`: revisar `ls /etc/letsencrypt/live/` |
| La tarjeta del clima dice "clima típico del mes" | El VPS no alcanza `api.open-meteo.com` |
