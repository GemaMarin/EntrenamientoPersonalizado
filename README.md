# Cuaderno de Entreno

App web instalable (PWA) para seguir mis entrenos:

- **Strava**: carreras, box/HIIT, marcas personales, ritmos, carga semanal.
- **Box**: WODs copiados de AimHarder, marcas y benchmarks.
- **Box**: lectura del WOD desde una captura de AimHarder o foto de la pizarra (OCR en el dispositivo con Tesseract.js) y fotos de Strava.
- **Objetivos**: competiciones con cuenta atrás, predicción y fases de preparación.
- **Plan**: semana que se adapta a la fase actual y se marca sola; resumen copiable para preguntar a Claude.

## Privacidad

Este repositorio solo contiene el código. Ningún dato personal se guarda aquí:

- El token de GitHub se guarda solo en el navegador de cada dispositivo (`localStorage`).
- Las credenciales de Strava (Client Secret y tokens) se guardan en el navegador y, para compartir la conexión entre dispositivos, **cifradas con AES-GCM** (clave derivada del token de GitHub con PBKDF2) dentro del Gist secreto.
- Los registros (WODs, marcas, competiciones) se sincronizan en un **Gist secreto** de la cuenta del usuario.

## Puesta en marcha

1. Abrir la app → **Ajustes** (icono de engranaje).
2. Crear una app en <https://www.strava.com/settings/api> con *Authorization Callback Domain* = el dominio de GitHub Pages (`<usuario>.github.io`). Pegar Client ID y Client Secret y pulsar **Conectar con Strava**.
3. Crear un token de GitHub con solo el permiso `gist` (<https://github.com/settings/tokens/new?scopes=gist>) y pegarlo en **Sincronización**.
4. En el móvil: menú del navegador → **Añadir a pantalla de inicio**.

## Archivos

| Archivo | Para qué |
|---|---|
| `index.html` | Estructura y estilos |
| `app.js` | Lógica: Strava API, sincronización con Gist, vistas |
| `sw.js` | Service worker para abrirla sin conexión |
| `manifest.webmanifest` | Nombre e iconos al instalarla |
