# TruckPanel — архитектура

Статус: черновик на ревью (фаза 0). Дата: 2026-10-05.
Источники и проверенные факты: `docs/research/`. Решения владельца: `context.md`.

## 1. Рамки v1

- Одно сообщество, один хост (VPS), роли на всю панель.
- Игры: ETS2 и ATS Dedicated Server, по одному Docker-контейнеру на сервер, всегда 128 слотов.
- UI: ru и en (i18n с первого дня).
- Нет в v1: 2FA, несколько хостов, кик и бан из панели (у SCS DS нет API), ввод команд в консоль (DS их не принимает), интеграция с VTCBase.

## 2. Компоненты

```text
                    Internet
                       │ 443 (HTTPS)
                       ▼
     ┌───────────────────────────────────┐
     │ Reverse proxy на хосте            │  существующий Nginx/Apache/Caddy
     │ (не часть compose)                │  или Caddy, поставленный установщиком
     └───────────────┬───────────────────┘
                     │ http://127.0.0.1:8080
┌────────────────────▼───────────────────────────────────── docker compose "truckpanel" ┐
│  ┌──────────────┐   internal net   ┌──────────────┐                                   │
│  │ panel        │─────────────────▶│ postgres     │  без публикации портов            │
│  │ Fastify API  │                  └──────────────┘                                   │
│  │ WS + SPA     │                                                                     │
│  │ task runner  │  unix socket /run/truckpanel/agent.sock                             │
│  └──────┬───────┘                                                                     │
│         ▼                                                                             │
│  ┌──────────────┐  /var/run/docker.sock (только здесь)                                │
│  │ agent        │  network_mode: host, без TCP-листенера                              │
│  └──────┬───────┘                                                                     │
└─────────┼─────────────────────────────────────────────────────────────────────────────┘
          │ Docker API
          ▼
  ┌───────────────┐ ┌───────────────┐ ┌───────────────┐
  │ tp-srv-<id1>  │ │ tp-srv-<id2>  │ │ tp-srv-<id3>  │   игровые контейнеры
  │ ETS2 DS       │ │ ETS2 DS       │ │ ATS DS        │   порты N:N TCP+UDP наружу
  └───────────────┘ └───────────────┘ └───────────────┘
```

### 2.1 panel (Node.js 22 LTS, TypeScript, Fastify)

- REST `/api/*` с OpenAPI (`@fastify/swagger`), WebSocket `/ws`, раздаёт статику SPA.
- Авторизация, RBAC, аудит, конфиги (ConfigManager), аллокатор портов (часть в БД), Discord, планировщик.
- Фоновые задачи: собственный исполнитель в процессе панели, состояние задач в PostgreSQL (таблица `tasks`). Изначально планировался pg-boss; почему от него отказались — `docs/features/servers.md`.
- **Нет** доступа к docker.sock и к файлам серверов. Всё это делается через agent.

### 2.2 agent (Node.js, TypeScript)

Минимальный «control plane», по смыслу как Wings у Pterodactyl.
- Единственный компонент с `docker.sock` и с RW-доступом к `/var/lib/truckpanel/servers`.
- API — **закрытый список** операций по `serverId` (не произвольные docker-команды):
  `install`, `start`, `stop(SIGINT)`, `kill`, `update`, `remove`, `stats`, `logs(stream)`, `files.*` (в пределах корня сервера), `writeConfig`, `uploadPackages`, `hostPorts`, `hostMetrics`, `backup`, `restore`.
- Слушает только unix socket в общем volume (права `0660`, группа panel), плюс общий токен из `.env`. TCP-порта нет.
- `network_mode: host`: видит реальные занятые порты хоста (`/proc/net/{tcp,tcp6,udp,udp6}`) для аллокатора и host-метрики.
- Docker-клиент — `dockerode`. Shell не используется. Аргументы контейнера собираются массивом, без интерполяции строк.

### 2.3 postgres 17

Только внутренняя сеть compose, порт не публикуется. Данные в `/var/lib/truckpanel/data/postgres`.

### 2.4 web (React + TypeScript + Vite)

- UI-библиотека: Mantine (тумблеры, формы, таблицы и уведомления из коробки; есть тёмная тема).
- Данные: TanStack Query (REST) + свой WS-клиент с автопереподключением. После реконнекта состояние перечитывается из REST.
- i18n: `i18next`, словари `ru`, `en`.

### 2.5 Общий пакет `shared`

Zod-схемы DTO и **схема конфигурации сервера** (ключ, тип, дефолт, валидация, restart-required, совместимость с игрой, ключи i18n для описаний и тултипов). Одна схема на frontend и backend.

## 3. Репозиторий

```text
/
  CLAUDE.md  context.md  CHANGELOG.md  .env.example
  apps/
    panel/        Fastify API + WS + jobs; migrations/ (drizzle-kit SQL)
    agent/        Docker/файлы/хост
    web/          React SPA
  packages/
    shared/       zod-схемы, config schema, типы WS-событий
    sii/          парсер/рендерер SII (чистый TS, без зависимостей)
  docker/
    panel.Dockerfile  agent.Dockerfile
    scs-server/Dockerfile   образ игрового сервера (SteamCMD)
    compose.yaml
  installer/
    install.sh  lib/*.sh   (discover, docker, proxy, tls, systemd, verify)
  docs/
```

Пакетный менеджер: pnpm workspaces. ORM и миграции: **Drizzle** (типобезопасный, генерирует SQL-миграции). Тесты: Vitest. Интеграционные идут на PGlite (PostgreSQL в WASM) с реальными миграциями, без Docker. Локальная разработка тоже может работать на PGlite (`DATABASE_URL=pglite://...`), см. `docs/DEVELOPMENT.md`.

## 4. Директории на хосте

```text
/opt/truckpanel/                 compose.yaml, .env (0600), версии образов
/var/lib/truckpanel/
  data/postgres/
  servers/<server-id>/
    game/                        файлы DS (SteamCMD)
    home/<Game Name>/            XDG_DATA_HOME: server_config.sii, server_packages.*, config_ds.cfg, логи
    steam/                       ~/.steam/sdk64/steamclient.so
  backups/<server-id>/<ts>.tar.zst
/var/log/truckpanel/             installer.log (логи сервисов — docker json-file с ротацией)
/run/truckpanel/agent.sock
```

Все пути к файлам сервера проверяются в agent: `realpath(join(root, rel))` должен начинаться с `root + "/"`. Симлинки наружу запрещены, нормализация до проверки.

## 5. Игровой контейнер

- Образ `truckpanel/scs-server` собирается локально установщиком из `docker/scs-server/Dockerfile`: Debian slim, SteamCMD, `lib32gcc-s1`, `ca-certificates`, uid 1000.
- **Установка и обновление:** одноразовый контейнер из того же образа выполняет
  `steamcmd +force_install_dir /srv/game +login anonymous +app_update <1948160|2239530> validate +quit`.
- **Запуск:** `XDG_DATA_HOME=/srv/home`, `HOME=/srv`, затем
  `bin/linux_x64/<eurotrucks2_server|amtrucks_server> -nosingle -server server_packages.sii -server_cfg server_config.sii`.
- Перед стартом agent пишет `config_ds.cfg` с `g_max_convoy_size "128"` и `g_console "0"` и проверяет наличие `server_packages.sii` и `.dat`.
- `StopSignal: SIGINT`, `stop timeout 30s`. Restart policy `no`: падения обрабатывает панель (статус ERROR, опционально авторестарт по настройке).
- Ограничения: `memory`, `nano_cpus`, `pids_limit`, `cap_drop: ALL`, `security_opt: no-new-privileges`, логи json-file 10m×3.
- Порты: `connection_dedicated_port` и `query_dedicated_port` публикуются TCP+UDP **N:N**. Виртуальные порты не публикуются.
  Если на VPS выяснится, что через bridge сервер не попадает в браузер сессий, переходим на `network_mode: host` (см. открытый вопрос 4 в research).

## 6. Данные (PostgreSQL)

| Таблица | Главное |
|---|---|
| users | id, username, email, password_hash (argon2id), role (enum), disabled, locale, created_at |
| sessions | id_hash (SHA-256 случайных 256 бит), user_id, ip, ua, last_seen_at, expires_at, revoked_at |
| servers | id uuid, name unique, game (`ets2`/`ats`), state, desired_state, data_dir, resource limits, auto_restart, created_at |
| server_ports | server_id, kind (`conn_dedicated`/`query_dedicated`/`conn_virtual`/`query_virtual`), port, proto; **UNIQUE(kind-класс, port)** |
| server_configs | server_id, version, values jsonb, secrets (шифр.), is_active, created_by; история версий = last known good |
| server_packages | server_id, sha256 sii/dat, uploaded_at, mods/dlc (из лога) |
| server_players | server_id, client_id, name, steam_id null, first_seen, last_seen, connected |
| server_stats | server_id, ts, cpu, mem, net_rx/tx, players (ретеншн 7 дней, агрегаты) |
| server_backups | id, server_id, path, size, sha256, status, kind (manual/scheduled) |
| discord_integrations | server_id PK, enabled, webhook_enc, webhook_id, message_id, interval, show_* флаги, status, last_error |
| scheduled_tasks | id, server_id null, kind (backup/restart/update), cron, enabled |
| tasks | id, server_id, kind, state, progress, log, created_by, timestamps (= installation_tasks из PLAN, но для всех долгих операций) |
| audit_logs | ts, user_id, action, target, old/new (без секретов), ip |
| system_settings | key, value jsonb |

Роли и права хранятся не в таблицах, а в коде (`packages/shared/src/permissions.ts`), роль — enum в `users.role`. Так одна матрица работает и в backend, и в UI, и она покрыта тестом.

Секреты (webhook, logon token, пароль сессии) хранятся как AES-256-GCM с `ENCRYPTION_KEY` из `.env`, формат `v1:iv:tag:ct`.

## 7. Ключевые подсистемы

### 7.1 Аллокатор портов

Транзакция в PostgreSQL с `pg_advisory_xact_lock(<const>)`:
1. берём занятые порты из `server_ports`;
2. берём занятые порты хоста у agent (`/proc/net/*` + опубликованные порты Docker);
3. выбираем: выделенные — первый свободный ≥ 27015 (пара conn/query), виртуальные — первая свободная пара в 100–200;
4. INSERT; UNIQUE-индекс — последняя защита от гонок.

Порты освобождаются при удалении сервера. Перед каждым стартом сервера проверяем повторно, что порт на хосте не занят посторонним процессом. Если занят, понятная ошибка с именем процесса и PID.

### 7.2 ConfigManager

`UI → DTO (zod) → validate → merge с фиксированными полями → render (packages/sii) → agent.writeConfig (tmp + fsync + rename) → активировать версию`.
- Фиксированные поля всегда перезаписываются панелью: `max_players: 128`, все 4 порта, `friends_only`, `show_server`.
- Ошибка рендера или записи: активная версия не меняется, файл на диске не тронут.
- Изменения при работающем сервере помечаются «нужен рестарт». Конфиг читается только на старте, поэтому для DS это все параметры.
- Парсер SII нужен для чтения `server_config.sii`, который DS сам сгенерировал при первом старте, и для тестов (round-trip).

### 7.3 Жизненный цикл и задачи

- Состояния: `NEW → INSTALLING → AWAITING_PACKAGES | STOPPED`, `STOPPED → STARTING → ONLINE → STOPPING → STOPPED`, `UPDATING`, `ERROR`, `UNKNOWN` (агент недоступен).
- Каждое действие — задача в `tasks`; на сервер одновременно выполняется одна операция, повторный запрос получает HTTP 409 `server.busy`.
- `ONLINE` определяется по A2S-ответу на query-порт, а не по факту «контейнер запущен». Контейнер работает, но A2S молчит больше N секунд: `STARTING`, затем `ERROR`.
- Reconciler раз в 10 с сверяет `desired_state` с реальным состоянием контейнера. Так ловим падения (NFR-002) и переживаем рестарт панели.

### 7.4 Консоль, логи, игроки

- agent стримит `docker logs -f` и хвост `server.log.txt` (что из них полезнее, проверим на VPS). Панель раздаёт поток в WS-канал `server.console` с проверкой права `console.view`.
- PlayerMonitor: парсит connected/disconnected (regex из старого монитора) + раз в 15 с A2S info для числа игроков. При рестарте сервера (`Session automated start`) список сбрасывается.
- Ввода команд нет: DS их не принимает. Поле ввода не рисуем.

### 7.5 Discord

См. `docs/research/discord-webhooks.md`. Отдельная задача для каждого сервера раз в `interval`. Одно сообщение на сервер, редактируется через PATCH. Лимитер общий на `webhook_id`.

### 7.6 Бэкапы

`tar.zst` из `home/` (конфиг, пакеты, логи — опционально) + JSON-снимок записи сервера. Файлы игры не бэкапим, они восстанавливаются через SteamCMD. Бэкап самой панели — `pg_dump` + `.env` (только по явному запросу, т.к. там ключи). Ретеншн по количеству.

### 7.7 WebSocket

Один сокет на вкладку, подписки `subscribe {serverId, channels[]}`. Каждая подписка проверяется по RBAC. События: `server.status`, `server.console`, `server.players`, `server.metrics`, `task.progress`, `server.error`. Аутентификация — cookie сессии, проверка `Origin`.

## 8. Безопасность

- Пароли — argon2id. Сессии в httpOnly-cookie (`Secure`, `SameSite=Lax`) с серверным хранением, «выйти везде».
- CSRF: double-submit токен для всех не-GET + проверка `Origin`.
- Rate limit на `/api/auth/*` и общий.
- RBAC проверяется на сервере, в каждом роуте через декларацию `permission: 'server.start'`. Матрица ролей лежит в `packages/shared`.
- Нет эндпоинтов с произвольной командой или docker run. agent принимает только перечисленные операции с валидированными параметрами.
- Загрузка файлов: лимит размера, имя только `[A-Za-z0-9._-]`, запись через agent с проверкой пути. `server_packages` проверяются по сигнатуре SII (`SiiNunit`).
- SSRF: исходящие HTTP только на Discord (allowlist хоста).
- Секреты не пишем в логи и аудит. Pino с redact-путями.

## 9. RBAC (черновик)

| Право | Admin | Manager | Moderator | Viewer |
|---|:-:|:-:|:-:|:-:|
| Просмотр серверов, статуса, игроков | ✓ | ✓ | ✓ | ✓ |
| Консоль (чтение), логи | ✓ | ✓ | ✓ | |
| Start/Stop/Restart | ✓ | ✓ | ✓ | |
| Kill/Update/Reinstall | ✓ | ✓ | | |
| Конфиг, список модераторов | ✓ | ✓ | модераторы | |
| Файлы, server_packages | ✓ | ✓ | | |
| Бэкапы: создать/восстановить | ✓ | ✓ | | |
| Discord | ✓ | ✓ | | |
| Создать/удалить сервер | ✓ | | | |
| Пользователи, настройки, аудит, диагностика | ✓ | | | |

## 10. Сценарии развёртывания (кратко, подробно — `VPS-COMPATIBILITY.md`)

Во всех сценариях панель слушает только `127.0.0.1:<port>`, а 80/443 принадлежат одному прокси на хосте.

| Сценарий | Что делает установщик |
|---|---|
| Чистый VPS | Предлагает поставить Caddy с официального репозитория. Caddy получает сертификат для поддомена. |
| VPS с Nginx | Отдельный vhost `truckpanel.conf`, сертификат через certbot webroot. Остальные сайты не трогаются. |
| VPS с Apache | Отдельный vhost + `a2ensite`. Модули proxy включаются только после подтверждения. Сертификат через certbot webroot. |
| VPS с Caddy | Файл `/etc/caddy/truckpanel.caddy` + одна строка `import` (с подтверждением). TLS делает Caddy. |
| VPS с Docker | Используем существующий Docker, если есть compose v2. Чужие контейнеры не трогаем, имена с префиксом `truckpanel-`/`tp-srv-`. |
| 80/443 занят неизвестным процессом (Traefik, HAProxy, другой контейнер) | Ничего не меняем. Выводим готовый фрагмент конфига и инструкцию, панель доступна через прокси пользователя. |
| Отдельный поддомен | Основной режим: `panel.example.com → IP VPS`. Основной сайт не переносится. Перед выпуском сертификата проверяем DNS. |
| SSL | Сертификатами управляет тот прокси, который уже держит 443. Второй ACME-клиент не появляется. |
| Откат | Бэкап → validate → reload → health check → при ошибке восстановить и снова reload. Каждое изменение пишется в манифест `/opt/truckpanel/installer-state.json` для отката и повторного запуска. |

## 11. Домен и HTTPS: что делает установщик, а что панель

Конфиги прокси на хосте меняет **только установщик** (root, интерактивно, с бэкапом). Панель работает в контейнере без root на хосте и системные конфиги не трогает. Так меньше поверхность атаки.

Поэтому в веб-мастере первого запуска шаги «Домен» и «HTTPS» **проверяют и показывают** состояние: DNS, сертификат, срок действия. Смена домена делается командой `sudo truckpanel-installer domain set <fqdn>`.
Это отступление от PLAN §7, нужно подтверждение владельца.

## 12. Открытые вопросы

1. Подтвердить §11 (домен и прокси меняет установщик, а не веб-мастер).
2. Проверки на тестовом VPS — список в `docs/research/scs-dedicated-server.md`.
3. Дефолтные лимиты ресурсов на сервер (RAM/CPU) — после замера на VPS.
