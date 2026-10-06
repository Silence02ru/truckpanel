# SCS Dedicated Server (ETS2 / ATS)

Дата проверки: 2026-10-05

## Источники

| Источник | URL | Статус |
|---|---|---|
| SCS Modding Wiki | https://modding.scssoft.com/wiki/Documentation/Tools/Dedicated_Server | первичный |
| SCS Blog (запуск DS) | https://blog.scssoft.com/2022/12/convoy-dedicated-servers-support.html | первичный |
| SCS Forum, консоль на DS | https://forum.scssoft.com/viewtopic.php?t=321335 | сообщество |
| LinuxGSM ets2server | https://github.com/GameServerManagers/LinuxGSM/blob/master/lgsm/config-default/config-lgsm/ets2server/_default.cfg | upstream |
| Хостинги про 128 слотов | https://help.freakhosting.com/games/euro-truck-simulator-2/increasing-convoy-max-players | вторичный |
| Наш старый скрипт | `install_ets2_server.sh`, `monitor_full_with_mods_instruction.py` | работал в проде |

## Факты

**Загрузка.** SteamCMD, анонимно. App ID: ETS2 DS `1948160`, ATS DS `2239530` (SCS wiki).
App ID самих игр (нужны для logon token): ETS2 `227300`, ATS `270880`.

**Бинарник (Linux).** `bin/linux_x64/eurotrucks2_server` (LinuxGSM). Для ATS — `bin/linux_x64/amtrucks_server` (старый скрипт; проверить на VPS).
Нужен `steamclient.so` в `~/.steam/sdk64/` (SCS wiki), берётся из SteamCMD `linux64/steamclient.so`.

**Параметры запуска** (SCS wiki): `-server <packages>`, `-server_cfg <cfg>`, `-homedir` (Windows), `-nosingle`.
На Linux home задаётся через `XDG_DATA_HOME`; данные лежат в `$XDG_DATA_HOME/Euro Truck Simulator 2/` (или `American Truck Simulator/`).
Решение: запускать `<bin> -nosingle -server server_packages.sii -server_cfg server_config.sii`.

**Остановка.** Ctrl+C (SCS wiki; LinuxGSM stop mode 2). В Docker: `StopSignal=SIGINT`, таймаут ~30 с, затем SIGKILL.

**Нет удалённого управления.** Нет UI, нет RCON. Консольные команды на DS не работают (форум SCS).
Модерация только в игре: `moderator_list` (Steam64 ID); команды в чате: `/set_time HH:MM`, `/set_rain_factor 0..1`, `/help`.
Кик в игре модератором упоминается только хостингами (`/kick <id>`), официально не подтверждено.
**Решение:** в панели нет кика, бана и ввода команд. Есть редактор `moderator_list`. Консоль работает только на чтение.

**Файлы в home** (SCS wiki): `server_config.sii` (создаётся при первом запуске), `server_packages.sii` + `server_packages.dat` (обязательны, создаются только в клиенте командой `export_server_packages`), `server.log.txt`, `server.crash.txt`.
Без пакетов в логе: `Server packages file not found`.
**Решение:** без загруженной пары `.sii` + `.dat` сервер получает статус `AWAITING_PACKAGES` и не стартует.

**Порты** (SCS wiki):
- `connection_virtual_port`, `query_virtual_port`: диапазон 100–200, проброс не нужен.
- `connection_dedicated_port`, `query_dedicated_port`: нужны TCP и UDP. Для LAN query должен быть в 27015–27020.
- «ports and logon token must be different for each session instance».
- **Решение:** аллокатор выдаёт уникальные порты: виртуальные парами из 100–200, выделенные начиная с 27015. Выделенные публикуются TCP+UDP с тем же номером на хосте (N:N), потому что сервер сообщает свой порт Steam.

**Query.** Протокол Valve A2S (LinuxGSM `protocol-valve`). Старый монитор успешно использует `a2s.info()` на `query_dedicated_port`: возвращает имя, карту, `player_count`, `max_players`.

**Игроки.** Имена берутся из лога (`server.log.txt`), regex из старого монитора:
- `\[MP\]\s+(.+?)\s+connected,\s+client_id\s*=\s*(\d+)`
- `\[MP\]\s+(.+?)\s+disconnected,\s+client_id\s*=\s*(\d+)`
- `\[MP\]\s+MOD\s+-\s*(.*)`, `\[MP\]\s+DLC\s+-\s*(.*)`, `\[MP\]\s+Session automated start`

SteamID в этих строках нет. Поле `steam_id` в БД оставляем nullable.

**128 слотов.** Вики SCS всё ещё пишет `max_players` «limit is 8», это устарело. С 1.50 конвой до 128 (вторичные источники; старый скрипт работал в проде с 128).
На сервере: `max_players: 128` в `server_config.sii` и `uset g_max_convoy_size "128"` в `config_ds.cfg`.
Клиенты тоже должны выставить у себя `g_max_convoy_size 128`, иначе не видят сервер в браузере сессий. Подсказка из старого монитора также советует `r_buffer_page_size 30` и фильтр «Сессия с модами».

**Logon token.** Без него сервер заходит анонимным аккаунтом и получает непостоянный search id. Токен выписывается на App ID **игры** (SCS wiki). Для каждого инстанса свой.

## Параметры `server_config.sii` (SCS wiki + старый скрипт)

| Ключ | Тип | Ограничение | В UI |
|---|---|---|---|
| lobby_name | string | ≤63 | текст |
| description | string | ≤63 | текст |
| welcome_message | string | ≤127 | текст |
| password | string | ≤63 | секрет |
| max_players | int | **128 фиксировано** | только показ |
| max_vehicles_total | int | диапазон не документирован | число |
| max_ai_vehicles_player | int | не документирован | число |
| max_ai_vehicles_player_spawn | int | не документирован | число |
| connection_virtual_port / query_virtual_port | int | 100–200 | только показ (аллокатор) |
| connection_dedicated_port / query_dedicated_port | int | — | только показ (аллокатор) |
| server_logon_token | string | — | секрет |
| player_damage, traffic, hide_in_company, hide_colliding, force_speed_limiter, mods_optioning, service_no_collision, in_menu_ghosting, name_tags | bool | — | тумблеры |
| timezones | int | 0–2 | select |
| friends_only, show_server | bool | «Not used for dedicated server» | не показываем, пишем значения по умолчанию |
| moderator_list | array of Steam64 | — | редактор списка |

Для числовых полей без документированного диапазона валидируем только «целое ≥ 0», без выдуманных максимумов.

**Кодировка строк.** Старый скрипт пишет не-ASCII как `\xNN` по байтам UTF-8 (`"\xd0\x94..."`). Рендерер SII должен экранировать так же, плюс `"` и `\`.

## Открытые вопросы (проверить на тестовом VPS)

1. Пишет ли DS в stdout то же, что в `server.log.txt` (для консоли через `docker logs`)?
2. Точное имя бинарника ATS.
3. Отдаёт ли `A2S_PLAYER` имена игроков (тогда лог-парсинг становится запасным вариантом).
4. Работает ли публикация портов N:N через Docker bridge для попадания в браузер сессий (иначе `network_mode: host` для игровых контейнеров).
5. Минимальные RAM и CPU на один инстанс со 128 слотами.

## Эксперимент на тестовом VPS (2026-10-05)

ETS2 DS **1.61.1.1**, Ubuntu 24.04 + Docker, контейнер `debian:bookworm-slim`, uid 1000.

Установка:
- SteamCMD: `https://client-update.steamstatic.com/installer/steamcmd_linux.tar.gz` (Valve wiki); пакет `lib32gcc-s1`; `+force_install_dir` до `+login anonymous` (рекомендация Valve).
- `steamcmd.sh +force_install_dir /srv/game +login anonymous +app_update 1948160 validate +quit` → `Success! App '1948160' fully installed.` Размер 1.3 ГБ, SteamCMD 195 МБ.
- Бинарник: `bin/linux_x64/eurotrucks2_server`. Рядом `server_launch.sh`: `LD_LIBRARY_PATH='$ORIGIN/../../linux64' ./eurotrucks2_server`. `steamclient.so` лежит в `<game>/linux64`, поэтому `~/.steam/sdk64` не нужен.
- Библиотеки рантайма (`ldd`): кроме glibc нужны **`libatomic1`** и **`libx11-6`**. Без них старт падает с ошибкой загрузки .so.

Запуск: `HOME=/srv XDG_DATA_HOME=/srv/home LD_LIBRARY_PATH=/srv/game/linux64`, cwd `bin/linux_x64`, `./eurotrucks2_server -nosingle`.
- Данные: `$XDG_DATA_HOME/Euro Truck Simulator 2/` — `server_config.sii`, `config_ds.cfg` (229 строк), `server.log.txt`, `profiles/`, `online/` и др.
- **stdout ≈ server.log.txt** (84 и 75 строк) → консоль можно строить на `docker logs`.
- **Без `server_packages`** сервер пишет 4 строки `*** ERROR *** : [MP] Error: Server packages file not found…` и **выходит с кодом 0**. Ловить нужно по логу, а не по коду выхода.
- Сгенерированный `server_config.sii`: ключи как в вики. Unit name `_nameless.50a.92e0` с точками. `server_logon_token: ""` в кавычках. Дефолт `timezones: 0` (в вики пример 2). Пустой список: `moderator_list: 0`.
- **Сервер перезаписывает `server_config.sii` при каждом запуске**: значения сохраняет (наш `max_players: 128` остался), unit name меняет на новый. Вывод: источник истины — БД панели, файл рендерится перед каждым стартом.
- `config_ds.cfg`: `uset g_max_convoy_size "8"` по умолчанию. Значение 128 после запуска сохраняется (`storing cvars` его не сбрасывает). Меняем только эту строку, остальной файл не трогаем.

Ещё не проверено (нужны настоящие `server_packages.sii/.dat` из игры):
- остановка по SIGINT;
- A2S на query-порту из Docker bridge;
- попадание в браузер сессий;
- RAM при работе.

## Проверка через agent на VPS (2026-10-05, фаза 3)

- **SteamCMD при первом запуске** скачивает обновление себя (≈40 МБ), перезапускается, и `app_update` падает с `ERROR! Failed to install app '1948160' (Missing configuration)`, код выхода 8. Повторный запуск сразу проходит: ≈72 с, 1.3 ГБ. → `tp-steamcmd-install` делает до 3 попыток.
- В конце SteamCMD печатает `Update state (0x0) unknown, progress: 0.00 (0 / 0)` — это не прогресс, agent его игнорирует.
- Игровой контейнер agent (uid 1000, read-only rootfs, cap_drop ALL, SIGINT, порты N:N TCP+UDP) запускает настоящий `eurotrucks2_server`. Без пакетов сервер выходит через ≈8 с с кодом 0.
- **Порядок вывода без пакетов:** 4 строки `*** ERROR ***` идут **первыми**, затем ≈80 строк завершения. Если смотреть только последние 80 строк, маркер теряется. → Панель читает при выходе до 1000 строк. Регрессионный тест повторяет эту раскладку.

## Полный прогон с настоящими server_packages (2026-10-06)

Пакеты владельца без модов: ETS2 — `europe.mbd` и 10 DLC; ATS — `usa.mbd` и 20 DLC. Конфиг сгенерировала панель (128 слотов, порты 27015/27016). Всё шло через agent на VPS.

- **A2S ответил через 6 с** (повторно через 3 с): `maxPlayers: 128`, map `/map/europe.mbd`. Поле version в A2S равно `1.0.0.1` — это не версия игры, показывать её как версию нельзя.
- Лог: `[MP] Session search id: 90294179854447616/101`, `Maximum number of players: 128`, `LogOn Anonymous` (logon token не задан), все DLC из пакетов перечислены.
- **`*** WARNING *** : [MP] Warning: Proper player limit exceeded.`** — DS предупреждает, что 128 больше официального лимита. Сервер при этом работает и отдаёт 128. В UI это нужно объяснять, а не скрывать (CLAUDE.md §12).
- Ресурсы в простое: **231 МБ RAM**, ~9% одного ядра.
- **Остановка по SIGINT: 1.9 с**, код выхода 0, штатное завершение (`Process manager shutdown`).
- После работы DS сохранил в `server_config.sii` наши 128, название и порты, а в `config_ds.cfg` — `g_max_convoy_size "128"`.
- Порты: 27015/27016 слушаются по TCP и UDP через docker-proxy (bridge-сеть, публикация N:N работает).

Осталось проверить: виден ли сервер в браузере сессий игры. Для этого нужен клиент; искать по search id или названию.

## Build ids (2026-10-06, phase 7.5)

- Installed build: `game/steamapps/appmanifest_1948160.acf` → `"buildid" "25488155"` (ETS2 DS on the test VPS, `StateFlags 4`).
- Latest build: LinuxGSM (`lgsm/modules/core_steamcmd.sh`) uses `+app_info_request <appid> +app_info_update 1 +app_info_print <appid>` and takes `buildid` of branch `public` inside `branches`. The Valve wiki page returned 403 to the fetcher; LinuxGSM is the upstream reference here.
