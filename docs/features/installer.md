# Установщик хоста

## Назначение

Ставит TruckPanel на VPS (Ubuntu 22.04/24.04/26.04, Debian 12, amd64) и не ломает то, что там уже работает. Стратегия описана в `docs/VPS-COMPATIBILITY.md`, здесь — как она реализована.

## Запуск

Одной командой с GitHub (скачивает последний релиз в `/opt/truckpanel-src/<версия>` и запускает `install.sh` с теми же флагами; `TRUCKPANEL_REF=<тег|main>` выбирает версию):

```bash
curl -fsSL https://raw.githubusercontent.com/Silence02ru/truckpanel/main/installer/get.sh | sudo bash -s -- --domain panel.example.com
```

Из распакованного исходника:

```bash
git clone <repo> truckpanel && cd truckpanel
sudo bash installer/install.sh --domain panel.example.com --dry-run   # только отчёт и план
sudo bash installer/install.sh --domain panel.example.com             # установка
sudo bash installer/install.sh verify
sudo bash installer/install.sh domain set new.example.com
sudo bash installer/install.sh rollback
sudo bash installer/install.sh uninstall [--purge-data]
```

Флаги: `--domain`, `--email`, `--proxy auto|caddy|nginx|apache|manual|none`, `--panel-port`, `--agree-tos`, `--skip-ssl`, `--skip-docker`, `--dry-run`, `--non-interactive`, `--yes`, `--install-certbot`, `--purge-data`.
В неинтерактивном режиме выполняется только то, что разрешено флагами: `--yes` одобряет план, `--agree-tos` — условия Let's Encrypt, `--install-certbot` — установку certbot.

## Архитектура

```text
installer/
  install.sh        разбор аргументов, подкоманды, порядок шагов
  lib/common.sh     логирование, confirm/ask (через /dev/tty), execute (dry-run), манифест, бэкапы
  lib/detect.sh     только чтение: ОС, ресурсы, Docker, порты (ss), Nginx/Apache/Caddy, certbot, ufw, DNS, IPv6
  lib/plan.sh       выбор прокси, блокирующие проблемы, отчёт и план
  lib/system.sh     пакеты, Docker (официальный репозиторий), каталоги, .env, сборка и запуск панели
  lib/proxy.sh      шаблоны, транзакции (backup → validate → reload → check → rollback), TLS
  lib/maintain.sh   verify, rollback, uninstall, domain set
  tests/            bats-тесты на подменных командах; run-in-docker.sh — проверка в контейнерах
```

### Выбор прокси (`--proxy auto`)

Решает процесс, который слушает 443/tcp (или 80/tcp):

| Владелец 443 | Действие |
|---|---|
| никто | поставить Caddy из официального репозитория |
| nginx | отдельный vhost `truckpanel.conf` (`sites-available` + symlink или `conf.d`) |
| apache2 | отдельный vhost + `a2ensite`; недостающие модули — только после подтверждения |
| caddy | файл в каталоге, который уже импортируется, иначе одна строка `import` в Caddyfile (после подтверждения) |
| traefik / haproxy / docker-proxy / другое | ничего не меняем, печатаем готовые фрагменты конфига |

Если чужой конфиг уже объявляет этот домен, установка останавливается: мы не перезаписываем чужие сайты.

### Транзакции и откат

Каждое изменение конфига прокси:

```text
бэкап (installer-backups/<run>/…) → запись → nginx -t | apache2ctl configtest | caddy validate
  → systemctl reload → проверка → при ошибке: восстановить файлы, снова validate+reload
```

Nginx и Apache настраиваются в два этапа, чтобы панель никогда не открывалась по HTTP:
1. HTTP-vhost отдаёт только `/.well-known/acme-challenge/` (на остальное 404). Проверка: локальный запрос через `curl --resolve` к пробному файлу.
2. `certbot certonly --webroot` (certbot не редактирует конфиги). Если сертификат для домена уже есть, он переиспользуется.
3. Редирект HTTP→HTTPS + HTTPS-vhost. Проверка: `https://<domain>/api/health` через `--resolve` должен вернуть 200 и заголовок `X-TruckPanel`.

Renewal делает штатный таймер certbot. Хук `/etc/letsencrypt/renewal-hooks/deploy/truckpanel-<service>.sh` после продления выполняет reload.

Манифест `/opt/truckpanel/installer-state`, по одной записи в строке:

- `created:<путь>`, `modified:<путь>|<бэкап>`;
- `pkg:<имя>`, `proxy:<тип>`, `apache-mod:<модуль>`, `step:<шаг>`.

`rollback` удаляет созданные файлы в `/etc`, восстанавливает **самый старый** бэкап изменённых (то есть состояние до TruckPanel), перезагружает прокси и останавливает контейнеры. Пакеты и данные не трогает.

### Панель

- Образ `truckpanel/panel:<версия>` собирается локально из checkout (`docker build`).
- `/opt/truckpanel/compose.yaml` копируется из `docker/compose.yaml`.
- `.env` (0600) создаётся один раз со случайными секретами (`openssl rand`). При повторных запусках меняются только `APP_URL`, `PANEL_PORT` и `TRUCKPANEL_VERSION`.
- Порт панели: 8080. Если он занят, установщик показывает процесс и PID и предлагает следующий свободный (8090, 8100…). При повторном запуске берётся порт из `.env`.
- В конце установщик выводит URL и токен установки, если администратора ещё нет.

## Безопасность

- Пользовательский ввод (домен, e-mail, порт) проверяется регулярными выражениями до использования. `eval` нет, команды передаются массивами.
- Docker ставится только по официальной инструкции. Существующий `docker.io` не удаляется. `podman-docker` блокирует установку.
- Firewall не трогаем: только предупреждение, что опубликованные Docker-порты обходят ufw.
- DNS проверяется без сторонних сервисов: адрес домена должен совпасть с адресом интерфейса хоста. Если не совпал, решает пользователь (например, хост за NAT).
- Условия Let's Encrypt принимает пользователь: явный вопрос или `--agree-tos`.
- Параллельные запуски блокируются через `flock`.

## Тесты

- `corepack pnpm test:installer` — 38 bats-тестов на подменных командах и фейковом корне ФС: разбор `ss`, выбор прокси, блокеры, шаблоны, транзакции и откат, сквозной `--dry-run`, который не меняет ни одного файла.
- `corepack pnpm test:installer:docker` — shellcheck (`install.sh` вместе с подключаемыми `lib/*.sh`), bats на Linux, `--dry-run` с настоящими утилитами в ubuntu:22.04/24.04 и debian:12. Требует запущенного Docker. Последний прогон 2026-10-05: всё зелёное.
- Полная установка проверяется на тестовом VPS (Ubuntu 24.04, `panel.example.com`), сценарии 3–10 из `VPS-COMPATIBILITY.md` §8 — на одноразовых VM.
  - 2026-10-05, сценарий 1 (чистая Ubuntu 24.04, 1.9 ГБ RAM + 2 ГБ swap) пройден:
    - Docker и Caddy установлены, сборка образа на VPS заняла несколько минут;
    - HTTP отдаёт 308 → HTTPS, сертификат Let's Encrypt выпущен;
    - `verify` — все проверки OK;
    - наружу открыты только 22, 80 и 443; панель слушает только 127.0.0.1:8080.
- По итогам прогона на VPS добавлено:
  - неразрешающийся домен при HTTPS-прокси теперь блокирует установку ещё на этапе отчёта (раньше она падала бы после установки Docker);
  - в отчёте RAM показывается с одним знаком после запятой;
  - при RAM меньше 2 ГБ выводится предупреждение про swap.

## Отличия от черновика VPS-COMPATIBILITY

- Отдельного systemd-юнита нет: контейнеры перезапускаются Docker'ом (`restart: unless-stopped`), Docker включён в systemd.
- Манифест — текстовый файл, а не JSON (без зависимости от jq).
- certbot ставится из apt дистрибутива, а не через snap (без snapd).
- Внешний IP не запрашивается у сторонних сервисов.

## Panel backup and restore (phase 7.4)

`install.sh backup` and `install.sh restore <file>`; a daily `truckpanel-backup.timer`. Details: `docs/features/backups.md`.
