# Конфигурация сервера и модераторы (фаза 4)

## Назначение

Все параметры `server_config.sii`, которые имеет смысл менять, редактируются в UI типизированными контролами (тумблеры, числа, select, секрет). Ручная правка файлов не нужна. Модераторы сессии добавляются по ссылке на профиль Steam.

## Источники

- Ключи, ограничения длины и описания — комментарии в списке «Server config parameters» вики SCS.
- Значения по умолчанию — `server_config.sii`, который DS 1.61 сгенерировал сам на тестовом VPS.
- Модераторы — `docs/research/steam-profiles.md`.

## Схема

`packages/shared/src/config-schema.ts`:
- `CONFIG_FIELDS`: ключ, группа, тип, ограничения. У всех полей `restartRequired: true`, потому что DS читает файл только при старте.
- `configUpdateSchema` (zod, `.strict()`): неизвестные ключи, `max_players`, порты, токен и `moderator_list` отклоняются с ошибкой 400.

| Группа | Поля |
|---|---|
| Сессия | lobby_name (1–63), description (≤63), welcome_message (≤127) |
| Доступ | password (≤63, секрет) |
| Игровой процесс | player_damage, hide_in_company, hide_colliding, force_speed_limiter, service_no_collision, in_menu_ghosting, name_tags |
| Трафик | traffic; max_vehicles_total, max_ai_vehicles_player, max_ai_vehicles_player_spawn (целое 0–65535 — это санитарная граница панели; SCS диапазон не документирует, и UI так и пишет) |
| Дополнительно | mods_optioning; timezones ∈ {0,1,2} («Values 0 - 2», смысл значений SCS не документирует — UI так и пишет) |

Поля, которые задаёт панель, а не пользователь:
- `max_players` — всегда 128;
- 4 порта;
- `server_logon_token` — карточка «Сессия в игре»;
- `moderator_list` — вкладка «Модераторы»;
- `friends_only` и `show_server` — по вики «not used for dedicated server».

## Хранение

- `server_configs`: каждое сохранение создаёт новую версию, предыдущая получает `active=false` и хранится как last known good. Изменения без отличий версию не создают.
- Пароль сессии хранится запечатанным (`v1:…`, AES-256-GCM). API возвращает только `passwordSet`.
  - пароль не передан — остаётся прежним;
  - `''` — удаляется;
  - строка — заменяет текущий.
- Аудит `server.config_update`: старые и новые значения только изменённых полей. Вместо пароля пишется `(set)/(empty)`.
- `servers.pending_restart` ставится при изменении конфига, модераторов или токена и снимается стартом, который отрендерил файл. `restartRequired = pending_restart && (ONLINE|STARTING)`.

## Модераторы

- Таблица `server_moderators`: `server_id`, `steam_id64` (text), `name`, `profile_url`, `added_by`, `added_at`. Пара UNIQUE(server, id).
- Принимаются три формы ввода:
  - `steamcommunity.com/profiles/<id64>` — ID берётся прямо из URL;
  - `steamcommunity.com/id/<имя>` — XML профиля `https://steamcommunity.com/id/<имя>/?xml=1`;
  - голый SteamID64 (`7656119` + 10 цифр).
- SSRF:
  - URL для запроса собирается из распарсенного имени, а не берётся у пользователя;
  - хост только `steamcommunity.com`;
  - `redirect: manual`, таймаут 5 с, ответ не больше 256 КБ.
- Если профиль не существует, Steam отвечает `<response><error>The specified profile could not be found.</error></response>`, панель возвращает 400 `moderator.not_found`.
- По голому ID модератор добавляется, даже если Steam недоступен; имя тогда пустое.
- Права: `server.moderators` (модератор и выше), лимит 20 добавлений в минуту.
- При старте `moderator_list` рендерится из таблицы. ID пишутся без кавычек, как в вики и в старом рабочем конфиге.

## API

| Метод | Путь | Право |
|---|---|---|
| GET | /api/servers/:id/config | server.view |
| PUT | /api/servers/:id/config | server.config |
| GET | /api/servers/:id/moderators | server.view |
| POST | /api/servers/:id/moderators `{input}` | server.moderators |
| DELETE | /api/servers/:id/moderators/:steamId64 | server.moderators |

## UI

- Вкладка «Конфигурация»:
  - карточки групп с описанием, у полей подписи, описания и подсказки;
  - счётчики символов, закреплённая внизу панель «Отменить / Сохранить»;
  - после сохранения на работающем сервере — диалог «[Перезапустить] [Позже]»;
  - без права `server.config` всё только для чтения.
- Вкладка «Модераторы»: поле для ссылки, список с именем и ссылкой на профиль, удаление.
- На «Обзоре» жёлтый баннер «Нужен перезапуск» с кнопкой.

## Тесты

`apps/panel/src/servers/config.test.ts`, 14 тестов:
- разбор ссылок: другие хосты, `steamcommunity.com.evil.com`, `../`, неверные ID;
- резолв `/id/` только через `steamcommunity.com` с `redirect: manual`;
- значения по умолчанию;
- версии и рендер при старте, включая экранирование UTF-8;
- отказ на неизвестные ключи, `max_players` и выход за диапазоны;
- пароль: шифрование, «не менять», удаление; не попадает ни в API, ни в аудит;
- `restartRequired`;
- аудит изменённых полей;
- RBAC;
- модераторы: дубликаты, недоступный Steam, рендер `moderator_list`, ошибки ввода, права.

Ручная проверка в UI (локально, 2026-10-06):
- сохранение конфига → версия 2;
- модератор по ссылке `/profiles/…` — имя получено из настоящего Steam.
