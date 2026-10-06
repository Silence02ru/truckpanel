# Reverse proxy и TLS

Дата проверки: 2026-10-05

## Источники

- Caddy import: https://caddyserver.com/docs/caddyfile/directives/import (поддерживает glob: `import sites-enabled/*`)
- Caddy reverse_proxy: https://caddyserver.com/docs/caddyfile/directives/reverse_proxy (WebSocket проксируется автоматически)
- Caddy установка: https://caddyserver.com/docs/install
- Caddy auto HTTPS: https://caddyserver.com/docs/automatic-https
- Nginx WebSocket proxying: https://nginx.org/en/docs/http/websocket.html
- Apache mod_proxy_wstunnel: https://httpd.apache.org/docs/2.4/mod/mod_proxy_wstunnel.html
- Certbot: https://eff-certbot.readthedocs.io/

## Решения

- Панель всегда слушает `127.0.0.1:<port>` (по умолчанию 8080, при занятости выбирается свободный). HTTP и WebSocket идут через один порт (`/api`, `/ws`, статика SPA).
- Каждый прокси получает **отдельный файл**. Общий конфиг не переписываем:
  - Nginx: `/etc/nginx/sites-available/truckpanel.conf` + symlink в `sites-enabled`. Если `sites-enabled` не подключён в `nginx.conf`, используем `/etc/nginx/conf.d/truckpanel.conf`. Нужны заголовки `Upgrade` и `Connection` для `/ws`.
  - Apache: `/etc/apache2/sites-available/truckpanel.conf` + `a2ensite`. Модули `proxy proxy_http proxy_wstunnel headers` включаются только после подтверждения, это глобальное изменение.
  - Caddy: файл `/etc/caddy/truckpanel.caddy`. Если в Caddyfile нет подходящего `import`, добавляем **одну** строку `import /etc/caddy/truckpanel.caddy` после бэкапа и подтверждения.
  - Traefik и HAProxy: автоматической интеграции нет. Показываем готовый фрагмент и инструкцию.
- TLS:
  - Caddy: встроенный ACME.
  - Nginx и Apache: если есть certbot, `certbot certonly --webroot` на наш домен (certbot не редактирует конфиги) + deploy hook `reload`. Если certbot нет, предлагаем установку с подтверждением или ручной вариант.
- Порядок изменения (CLAUDE.md §10): backup → write → validate (`nginx -t` / `apache2ctl configtest` / `caddy validate`) → reload → health check `https://<domain>/api/health` → при ошибке откат и повторный reload.
