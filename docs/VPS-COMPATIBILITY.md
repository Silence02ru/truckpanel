# TruckPanel — совместимость с VPS и стратегия установки

Статус: черновик на ревью (фаза 0). Дата: 2026-10-05.
Основа: `CLAUDE.md` §2–11, §23–24, `docs/research/reverse-proxy-tls.md`, `docs/research/docker-and-host.md`.

## 1. Принципы

1. VPS может быть не пустым. Сначала только чтение (discovery), потом отчёт, потом подтверждение и только после этого изменения.
2. Ни одно изменение не трогает чужие сайты, сертификаты, контейнеры и firewall.
3. Каждое изменение: backup → apply → validate → reload → health check → rollback при ошибке.
4. Установщик идемпотентен: повторный запуск видит, что уже сделано (манифест), и не делает это второй раз.
5. Поддерживаемые ОС: Ubuntu 22.04 / 24.04 / 26.04, Debian 12, архитектура amd64. Остальные — остановка с объяснением.
   Тестовая площадка: Ubuntu 24.04, чистая, домен `panel.example.com`.

## 2. Поток установщика

```text
install.sh
  1. preflight      root? ОС/версия/arch? systemd? → иначе стоп
  2. discover       только чтение, собирает отчёт (§3)
  3. report         печатает отчёт и план изменений (§4)
  4. confirm        [y/N] на каждый блок изменений (или --non-interactive + явные флаги)
  5. deps           curl, ca-certificates, git, openssl (apt, только недостающие)
  6. docker         есть → пропуск; нет → официальный репозиторий
  7. layout         пользователь truckpanel, /opt, /var/lib, /var/log, .env (0600, секреты из openssl rand)
  8. images         сборка scs-server, pull/сборка panel+agent, compose up
  9. migrate        миграции БД в контейнере panel
 10. proxy+tls      по сценарию (§5), с откатом
 11. verify         health check по 127.0.0.1 и по https://<domain>
 12. finish         URL + одноразовая ссылка на создание администратора (не пароль в stdout)
```

Флаги: `--domain`, `--email`, `--non-interactive`, `--skip-ssl`, `--skip-docker`, `--proxy=auto|caddy|nginx|apache|manual|none`, `--panel-port`, `--dry-run` (только discover + report).
Подкоманды для повторного запуска: `domain set <fqdn>`, `verify`, `rollback`, `uninstall` (данные серверов удаляются только с отдельным подтверждением).

## 3. Discovery (только чтение)

| Что | Как |
|---|---|
| ОС, версия, arch | `/etc/os-release`, `uname -m` |
| CPU, RAM, диск | `nproc`, `/proc/meminfo`, `df -B1 /var/lib` |
| systemd | `pidof systemd`, `systemctl --version` |
| Docker, compose | `command -v docker`, `docker version`, `docker compose version`, `dpkg -l docker.io docker-ce podman-docker` |
| Контейнеры | `docker ps --format` (имена и опубликованные порты) |
| Прокси | `systemctl is-active nginx apache2 caddy traefik haproxy`, `command -v ...` |
| Кто держит порты | `ss -Htlnp`, `ss -Hulnp`: 80, 443, панель (8080, 8000, 3000), игровые 27015+ |
| Nginx-структура | `nginx -T` (только чтение): есть ли `include sites-enabled/*`, `conf.d/*.conf`, кто уже слушает `server_name <domain>` |
| Apache | `apache2ctl -S`, `apache2ctl -M` (модули proxy) |
| Caddy | `/etc/caddy/Caddyfile`, есть ли `import`, нет ли уже блока `<domain>` |
| Certbot | `command -v certbot`, `certbot certificates` |
| Firewall | `ufw status`, `nft list ruleset` / `iptables -S` (только показ) |
| DNS | `getent ahosts <domain>` или DoH-запрос vs публичный IP (`curl https://api.ipify.org` — только с согласия, иначе ввод вручную) |
| PostgreSQL/MySQL на хосте | `ss` на 5432/3306 — не используем, только чтобы не конфликтовать |

Discovery ничего не пишет, кроме `/var/log/truckpanel/installer.log`. Флаг `--dry-run` на этом и заканчивает.

## 4. Отчёт и план

```text
System inspection
OS            Ubuntu 24.04 (amd64)        ✓
CPU / RAM     4 cores / 8 GB              ✓
Disk          120 GB free                 ✓
Docker        not installed               → will install (official repo)
Nginx         not installed
Caddy         not installed
Port 80/443   free
Port 8080     free                        → panel on 127.0.0.1:8080
Port 27015+   free
DNS           panel.example.com → 203.0.113.10 (this VPS) ✓

Planned changes
 1. Install Docker Engine + compose plugin   [y/N]
 2. Install Caddy (official repo), own :80/:443 [y/N]
 3. Create /opt/truckpanel, /var/lib/truckpanel, user truckpanel
 4. Start TruckPanel on 127.0.0.1:8080
```

## 5. Сценарии

### 5.1 Чистый VPS (наш тестовый)

- Docker ставится из официального репозитория.
- Прокси нет, поэтому предлагаем: `Install Caddy` (рекомендуется) / `Manual` / `Custom port only`.
- Caddy ставится из официального apt-репозитория **на хост** (а не в compose), чтобы позже на тот же 443 можно было добавить другие сайты.
  Caddyfile создаётся заново: `import /etc/caddy/sites/*.caddy` + наш `sites/truckpanel.caddy`:
  ```caddy
  panel.example.com {
      reverse_proxy 127.0.0.1:8080
  }
  ```
- Сертификат выпускается только после DNS-проверки и проверки, что 80 и 443 свободны.

### 5.2 Nginx уже есть

- Новый файл `/etc/nginx/sites-available/truckpanel.conf` + symlink (или `conf.d/truckpanel.conf`, если `sites-enabled` не подключён).
- Сначала HTTP-блок с `location /.well-known/acme-challenge/ { root /var/lib/truckpanel/acme; }`, затем `certbot certonly --webroot -w /var/lib/truckpanel/acme -d <domain>`, затем HTTPS-блок с `proxy_pass http://127.0.0.1:8080` и заголовками `Upgrade`/`Connection` для `/ws`.
- certbot есть: используем его. Нет: предлагаем установить (с подтверждением) или «вставьте свой сертификат / настройте сами».
- Если `server_name <domain>` уже где-то объявлен, стоп и объяснение: не перезаписываем чужой vhost.
- Renewal: штатный таймер certbot + deploy-hook `/etc/letsencrypt/renewal-hooks/deploy/truckpanel-nginx.sh` (`nginx -t && systemctl reload nginx`).

### 5.3 Apache уже есть

- `/etc/apache2/sites-available/truckpanel.conf`, `a2ensite truckpanel`.
- Модули `proxy proxy_http proxy_wstunnel headers` (и `ssl`): показываем, каких не хватает, и включаем только после подтверждения, потому что это глобальное изменение.
- TLS через certbot webroot, как для Nginx. Проверка `apache2ctl configtest`.

### 5.4 Caddy уже есть

- Пишем `/etc/caddy/truckpanel.caddy`.
- Если Caddyfile уже импортирует директорию, кладём файл туда. Если нет, показываем diff на одну строку `import /etc/caddy/truckpanel.caddy` и добавляем её после подтверждения и бэкапа.
- `caddy validate --config /etc/caddy/Caddyfile` → `systemctl reload caddy`. TLS делает сам Caddy.

### 5.5 Docker уже есть

- `docker-ce` + compose v2: используем.
- `docker.io` из Ubuntu без compose v2: **не удаляем**. Варианты: поставить `docker-compose-v2` из Ubuntu (с подтверждением) / выйти и сделать вручную. Замена на docker-ce — только по явному выбору с предупреждением, что затронет все контейнеры.
- `podman-docker` или rootless: не поддерживается в v1, стоп с объяснением.
- Наши объекты получают имена `truckpanel-*` (compose project) и `tp-srv-<id>`. Чужие контейнеры, сети и volume-ы не трогаются.
- Предупреждение в отчёте: опубликованные игровые порты обходят ufw (см. research).

### 5.6 80/443 заняты неизвестно чем (Traefik, HAProxy, контейнер, другой софт)

- Ничего не меняем. Печатаем готовый фрагмент для их прокси (upstream `127.0.0.1:<port>`, WebSocket на `/ws`), ссылку на документацию и команду `truckpanel-installer verify` для проверки после ручной настройки.
- Альтернатива: `Custom port only`. Панель публикуется на `0.0.0.0:<port>` **только** с HTTPS через собственный самоподписанный сертификат и предупреждением. По умолчанию выключено.

### 5.7 Отдельный поддомен

Основной режим. Пользователь создаёт `A`/`AAAA` для `panel.example.com` (у нас `panel.example.com`), основной сайт остаётся на месте. Установщик объясняет это в отчёте (текст из `CLAUDE.md` §4).

### 5.8 Порты панели и игр

- Панель: 8080, при занятости показываем процесс и PID и предлагаем первый свободный (8090, 8100, …).
- Игры: аллокатор панели (см. `ARCHITECTURE.md` §7.1) проверяет и БД, и реальную занятость портов на хосте.

## 6. Откат и идемпотентность

- Манифест `/opt/truckpanel/installer-state.json`: какие шаги выполнены, какие файлы созданы, какие изменены (путь + путь бэкапа + sha256), какие пакеты поставлены установщиком.
- Бэкапы: `/var/lib/truckpanel/installer-backups/<ts>/<путь>`.
- Изменение конфига прокси — транзакция:
  ```text
  backup → write → validate → reload → curl health (HTTP 200 /api/health, ожидаемый заголовок X-TruckPanel)
       ✗ на любом шаге → restore backup → validate → reload → сообщение с причиной
  ```
- `rollback`: откатывает изменения прокси и сервисы панели по манифесту. Docker и пакеты не удаляет (их могли начать использовать другие). Данные серверов не трогает.
- Повторный запуск: шаги из манифеста проверяются (и чинятся, если «уехали»), а не выполняются заново.

## 7. Что требует отдельного подтверждения всегда

CLAUDE.md §24: удаление сервера или данных, удаление Docker, изменение или удаление существующего прокси, замена TLS, широкие изменения firewall, SSH, удаление бэкапов, изменение чужих сайтов.
`--non-interactive` подтверждает только то, что явно задано флагами. Например, `--proxy=nginx` разрешает правку Nginx, но не установку certbot без `--install-certbot`.

## 8. Тестовая матрица установщика

| # | Окружение | Ожидание |
|---|---|---|
| 1 | Чистая Ubuntu 24.04 (тестовый VPS) | Docker + Caddy + HTTPS на `panel.example.com`, панель открывается |
| 2 | Повторный запуск на #1 | Нет изменений, всё ✓ |
| 3 | Ubuntu 24.04 + Nginx + сайт на 443 + certbot | Сайт не затронут, панель на поддомене |
| 4 | + Apache | Аналогично |
| 5 | + Caddy с существующим сайтом | Аналогично |
| 6 | + docker.io от Ubuntu | Не удалён, корректный выбор |
| 7 | 8080 занят | Предложен другой порт |
| 8 | DNS указывает не туда | Сертификат не запрашивается, понятная ошибка |
| 9 | Сломанный vhost (искусственно) | Автооткат, чужая конфигурация цела |
| 10 | Debian 12 чистый | Как #1 |

Сценарии 3–10 — на одноразовых VM или контейнерах (systemd-in-docker / multipass), **не** на рабочем VPS.
