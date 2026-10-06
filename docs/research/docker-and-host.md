# Docker и хост

Дата проверки: 2026-10-05

## Источники

- https://docs.docker.com/engine/install/ubuntu/
- https://docs.docker.com/engine/install/debian/
- https://docs.docker.com/engine/network/packet-filtering-firewalls/
- https://developer.valvesoftware.com/wiki/SteamCMD
- https://github.com/pterodactyl/wings (разделение панели и control plane)
- https://github.com/GameServerManagers/LinuxGSM

## Факты

- Поддерживаемые Ubuntu: 22.04, 24.04, 26.04. Пакеты: `docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin`. Ключ репозитория в `/etc/apt/keyrings/docker.asc`, источник в `/etc/apt/sources.list.d/docker.sources`.
- Официальная инструкция просит **удалить** конфликтующие пакеты (`docker.io`, `docker-compose`, `docker-compose-v2`, `podman-docker`, `containerd`, `runc`). На чужом VPS это деструктивно.
- Опубликованные порты контейнеров **обходят ufw**: трафик уходит в таблицу `nat` раньше цепочек INPUT/OUTPUT. Поддерживаются только `iptables-nft` и `iptables-legacy`.
- Wings — отдельный процесс-«control plane» рядом с Docker. Панель общается с ним по API, и только он трогает Docker, файлы и логи.

## Решения

- Docker уже установлен (любой пакет) и есть `docker compose` v2: используем как есть. `docker.io` без compose-плагина: **не удаляем**, предлагаем действия и ждём подтверждения.
- Docker нет: ставим строго по официальной инструкции (apt-репозиторий download.docker.com), только после подтверждения.
- Внутренние сервисы (panel, postgres) публикуются только на `127.0.0.1` или не публикуются вовсе. Наружу смотрят только игровые порты.
- Из-за обхода ufw игровые порты фактически открыты, даже если ufw их не разрешает. Диагностика честно об этом пишет, установщик не трогает firewall без явного выбора.
- Игровой контейнер: свой образ (Debian slim + SteamCMD + `lib32gcc-s1`), пользователь без root, `cap_drop: ALL`, `no-new-privileges`, лимиты memory, cpus и pids, `StopSignal: SIGINT`.
- Файлы игры ставятся отдельно для каждого сервера (`/var/lib/truckpanel/servers/<id>/game`). Общая установка на игру сэкономила бы место, но обновление одного сервера затрагивало бы остальные. Вернёмся к этому после v1.

## Просмотрено и отклонено

- https://github.com/rachittshah/trucksim-mcp (MIT): телеметрия игрового **клиента** через SCS Telemetry SDK. Управления сервером, RCON и списков игроков нет. Для панели не нужен.
