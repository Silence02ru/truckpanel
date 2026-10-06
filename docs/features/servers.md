# Игровые серверы: agent, порты, жизненный цикл

Фаза 3. Источники и эксперимент на VPS: `docs/research/scs-dedicated-server.md`.

## Компоненты

```text
web ──REST──▶ panel (ServerManager, задачи, порты, БД) ──unix socket + Bearer──▶ agent ──docker.sock──▶ контейнеры
```

- **agent** (`apps/agent`) — единственный компонент с `docker.sock`. Работает в `network_mode: host`, слушает unix-сокет `/run/truckpanel/agent.sock` (0660, группа 1000), TCP-порта нет. Список операций закрыт:
  - `GET  /v1/health`, `GET /v1/host/ports` (из `/proc/net/{tcp,tcp6,udp,udp6}`), `GET /v1/servers`;
  - `POST /v1/servers/:id/install` (NDJSON-поток прогресса SteamCMD), `start`, `stop`, `kill`, `DELETE /v1/servers/:id?purge=1`;
  - `GET .../state`, `.../logs?tail=`, `.../query` (A2S_INFO на 127.0.0.1);
  - `GET|PUT .../files/:file`, `.../files/:file/stat` — только `server_config.sii`, `config_ds.cfg`, `server_packages.sii`, `server_packages.dat`.

  id — только UUID, пути проверяются через `resolveInside`. Операции на одном сервере сериализуются, SteamCMD на хосте одновременно запускается один.
- **образ `truckpanel/scs-server`** (`docker/scs-server`): Debian slim, `lib32gcc-s1` (SteamCMD), `libatomic1` и `libx11-6` (нужны `eurotrucks2_server`, проверено `ldd`), tini, uid 1000. Скрипт `tp-steamcmd-install <appid>` принимает только 1948160 и 2239530.
- **SteamCMD** лежит в `/var/lib/truckpanel/steamcmd`, общий для хоста, и обновляет себя один раз. Сразу после самообновления `app_update` может один раз упасть с «Missing configuration» (проверено на VPS), поэтому скрипт делает до 3 попыток.

## Контейнер игрового сервера

`tp-srv-<uuid>`:
- uid 1000, `ReadonlyRootfs`, `CapDrop ALL`, `no-new-privileges`, `PidsLimit 512`, лимиты RAM и CPU;
- `StopSignal SIGINT` + 30 с, restart policy `no` (падения обрабатывает панель);
- `HOME=XDG_DATA_HOME=/srv/home`, `LD_LIBRARY_PATH=/srv/game/linux64`;
- команда: `./eurotrucks2_server -nosingle -server server_packages.sii -server_cfg server_config.sii` (флаги из рабочего legacy-скрипта);
- bind-монтирования: `servers/<id>/game` → `/srv/game`, `servers/<id>/home` → `/srv/home`;
- порты: `connection_dedicated_port` и `query_dedicated_port` публикуются TCP+UDP с тем же номером на хосте. Виртуальные порты не публикуются.

При изменении портов, лимитов или образа контейнер пересоздаётся (метка `truckpanel.spec`). Данные лежат в bind-монтированиях и не теряются.

## Порты

`allocatePorts()` выполняется в транзакции под `pg_advisory_xact_lock`:
- host: пара `p`/`p+1`, начиная с 27015; пропускаются порты из БД и реально занятые на хосте (TCP или UDP);
- virtual: пара из 100–200;
- `UNIQUE(space, port)` в `server_ports` — последняя защита от гонок;
- перед каждым стартом порты проверяются ещё раз, на случай если их заняла посторонняя программа.

## Конфиг

- `server_config.sii` рендерится из БД перед **каждым** стартом: DS перезаписывает файл сам (значения сохраняет, unit name меняет).
- `max_players: 128` и четыре порта всегда берутся у панели.
- Значения по умолчанию — из конфига, который сгенерировал сам DS 1.61.
- В `config_ds.cfg` меняется только строка `uset g_max_convoy_size "128"`. Если файла ещё нет, создаётся минимальный, остальное DS допишет сам.

## Состояния и задачи

```text
NEW → INSTALLING → AWAITING_PACKAGES ⇄ (upload) → STOPPED → STARTING → ONLINE
ONLINE → STOPPING → STOPPED;   * → ERROR;   agent недоступен → UNKNOWN;   update: UPDATING
```

Задачи (`tasks`):

| Задача | Право |
|---|---|
| start / stop / restart | `server.power` (модератор и выше) |
| install / update / kill | `server.maintain` (менеджер и выше) |
| delete | `server.delete` (только администратор), нужно ввести имя сервера |

- HTTP отвечает сразу `202 + task`, выполнение идёт в фоне. Прогресс и последние 300 строк лога пишутся в БД не чаще раза в секунду.
- На одном сервере одновременно идёт одна задача, повторный запрос получает `409 server.busy`.
- **ONLINE** означает, что A2S_INFO ответил, а не просто что контейнер запущен. Если A2S не ответил за 180 с, задача завершается, а reconciler продолжает проверять.
- Если DS вышел и в логе есть `Server packages file not found` → `AWAITING_PACKAGES`, флаги пакетов сбрасываются. Это нужно, потому что без пакетов DS выходит с кодом 0.
- Reconciler раз в 10 с замечает:
  - падения: ONLINE, но контейнер вышел → `ERROR` с кодом выхода и последними строками лога;
  - запуск в обход панели;
  - недоступность agent.
- При старте панели незавершённые задачи помечаются `failed: Interrupted by a panel restart`, переходные состояния становятся `UNKNOWN`, затем идёт сверка.

**Отступление от плана.** Вместо pg-boss используется собственный исполнитель задач в процессе панели. Панель одна на хост, состояние задач хранится в PostgreSQL, сериализация по серверу сделана через `Map` + проверку в БД. Так меньше движущихся частей, и всё тестируется на PGlite. Для расписаний (фаза 7) вопрос вернётся.

## server_packages

`PUT /api/servers/:id/packages`: multipart, поля `sii` и/или `dat`, до 64 МБ каждый, право `server.files`.
- `.sii` должен начинаться с `SiiNunit`, `.dat` не может быть пустым.
- Когда загружены оба файла, `AWAITING_PACKAGES` → `STOPPED`.
- UI объясняет, как получить файлы: `g_console 1` → загрузить карту → `export_server_packages`.

## UI

- Главная: таблица в стиле OVH — имя и прогресс задачи, игра, `host:port`, статус, игроки N/128, кнопки питания, «Открыть».
- В сайдбаре, в секции «Инстансы», — список серверов с цветом статуса.
- Страница сервера:
  - шапка со статусом и действиями (Запустить / Остановить / Перезапустить / Ещё: обновить, переустановить, kill);
  - вкладки «Обзор» и «Консоль» (чтение `docker logs`);
  - на «Обзоре»: прогресс задачи, ошибка, плитки, карточка `server_packages` с инструкцией, история задач, «Опасная зона».
- Обновление идёт опросом каждые 3 с; в фазе 5 его заменит WebSocket.

## Тесты

- `apps/agent` (15): `/proc/net`, прогресс SteamCMD, path traversal, определение контейнера (hardening, порты N:N, флаги), demux логов, A2S с challenge по настоящему UDP, токен, валидация, белый список файлов, поток установки.
- `apps/panel/src/servers` (17) на фейковом agent и PGlite:
  - рендер 128 слотов, точечная правка `config_ds.cfg`;
  - выделение портов: занятые на хосте, конкурентное создание;
  - дубликат имени, agent недоступен, провал SteamCMD;
  - пакеты, старт до ONLINE, busy, «нет пакетов» по логу, порт занят;
  - падение через reconciler, восстановление после рестарта;
  - RBAC, удаление с подтверждением и освобождением портов.
- `packages/sii` (9): в том числе настоящий конфиг DS 1.61 и Steam ID больше 2^53.

## Logon token и постоянный Session search id

- **Без токена** DS входит в Steam анонимно и при **каждом** запуске получает новый `Session search id` (вики SCS; на VPS: `LogOn Anonymous`, ID `90294179854447616/101`). С токеном аккаунт игрового сервера постоянный, и ID не меняется.
- **Токен** создаётся на https://steamcommunity.com/dev/managegameservers для App ID **игры**: ETS2 227300 (подтверждено логом DS: `breakpad minidump AppID = 227300`), ATS 270880. Для каждого сервера нужен свой токен.
- **`PUT /api/servers/:id/logon-token`** с телом `{ token | null }`, право `server.config` (менеджер и выше):
  - формат `^[A-Za-z0-9]{16,64}$`;
  - в БД хранится в `servers.logon_token_enc` (AES-256-GCM, `lib/secrets.ts`) и `logon_token_hash` (SHA-256 с ключом, UNIQUE → `409 server.token_in_use`);
  - API отдаёт только `logonTokenSet`, в аудит пишется факт установки или удаления без значения;
  - в `server_configs.values` токен не попадает никогда: расшифровывается только при рендере перед стартом и пишется без кавычек, как в вики.
- **Search id**: после ONLINE (при старте и в reconciler) панель читает лог и берёт последнее `[MP] Session search id: …` в `servers.session_search_id`. При смене или удалении токена значение сбрасывается: следующий запуск даст новый ID.
- **UI**: карточка «Сессия в игре» — search id с копированием, бейдж «Постоянный ID / ID меняется при запуске», инструкция и поле токена.
- Тесты (`logon-token.test.ts`, 8 шт.):
  - шифрование: round-trip, подмена данных, чужой ключ;
  - разбор search id;
  - токен попадает в конфиг, но отсутствует в API, `server_configs` и аудите;
  - один и тот же токен на двух серверах → 409;
  - удаление токена → `""` в конфиге;
  - валидация формата и RBAC.

## Task log and errors (0.6.1)

- Every task keeps the last 300 lines of output (`tasks.log`). The UI shows it with the "Лог" button on the running task and in the task history (`GET /api/tasks/:id`).
- SteamCMD prints `flock /sys/devices/virtual/dmi/id/... LOCK_SH failed. errno = 13` inside the container: it cannot lock hardware info in read-only `/sys`. It is harmless; the panel drops these lines, splits glued lines and collapses repeated progress lines.
- Failure codes: `steamcmd.failed` (the message includes the last meaningful SteamCMD lines), `task.interrupted` (the agent stream broke or the panel restarted mid-task, typically during a panel update — restart the task, SteamCMD resumes the download).

## Panel logs on the host

```bash
cd /opt/truckpanel
docker compose logs -f --tail 200 panel
docker compose logs -f --tail 200 agent
```

Logs are JSON (pino); webhook URLs, tokens and passwords are never logged.

## server_packages history (phase 7.3)

- Upload validates `server_packages.sii` with the SII parser: the unit `server_packages_info` must exist (structure of real DS 1.61 exports, `packages/sii/src/fixtures`). The card shows the map, DLC and mod counts, size, sha256, who uploaded it and when.
- Before replacing a complete pair, the agent copies it to `<server>/packages-history/<UTC time>/` (outside the game home); the newest 5 versions are kept (`PACKAGE_HISTORY_KEEP`).
- Rollback (`POST /api/servers/:id/packages/restore {version}`) stores the current pair first, then puts the chosen one back (copy + atomic rename). The version is validated against `PACKAGE_VERSION_RE` in the panel and again in the agent and resolved inside the history directory (no path traversal).
- Download: `GET /api/servers/:id/packages/sii|dat`.
- The DS reads server_packages when it starts (without them it stops right after start, see research), so replacing or rolling back on a running server sets «нужен перезапуск».
- Everything needs `server.files` (manager, owner, administrator); audit actions `server.packages_upload`, `server.packages_restore`.
