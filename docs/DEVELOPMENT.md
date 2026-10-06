# Разработка

## Требования

- Node.js ≥ 22 (проверено на 24), corepack (pnpm 12 ставится сам по `packageManager`).
- Проект должен лежать на **локальном диске**. На сетевой шаре (SMB) pnpm падает с os error 4392, потому что не может создать ссылки.
- Docker нужен только для образа и compose. Тесты и локальный запуск работают без него (PGlite).

## Переводы строк

Все текстовые файлы в репозитории используют LF (`.gitattributes`). Shell-скрипты с CRLF не запускаются на Linux. Проверка:

```bash
grep -rlI $'\r' --exclude-dir=node_modules --exclude-dir=.pglite --exclude-dir=dist .
```

## Команды

```bash
corepack pnpm install
corepack pnpm --filter @truckpanel/shared build   # shared нужно собрать до запуска panel
corepack pnpm -r typecheck
corepack pnpm -r test
```

Локальный запуск (два терминала):

```bash
corepack pnpm dev:panel   # API на 127.0.0.1:8080, читает ../../.env
corepack pnpm dev:web     # Vite на http://localhost:5173, проксирует /api и /ws
```

Пример `.env` для разработки:

```text
NODE_ENV=development
APP_URL=http://localhost:5173
DATABASE_URL=pglite://../../.pglite
ENCRYPTION_KEY=<openssl rand -base64 32>
INITIAL_SETUP_TOKEN=<openssl rand -base64 36>
TRUST_PROXY_HOPS=0
```

`pglite://<папка>` — встроенный PostgreSQL (WASM), данные лежат в `.pglite/` в корне, папка в `.gitignore`. Чтобы начать с нуля, удалите её.
Настоящий PostgreSQL: `docker compose -f docker/compose.dev.yaml up -d` и `DATABASE_URL=postgres://truckpanel:dev@127.0.0.1:5432/truckpanel`.

## Миграции

Схема: `apps/panel/src/db/schema.ts`. После изменения:

```bash
corepack pnpm --filter @truckpanel/panel db:generate --name <что_изменилось>
```

Сгенерированный SQL в `apps/panel/migrations/` коммитится. Панель применяет миграции сама при старте.
Существующие миграции не редактируются, только новые.

## Тесты

- `packages/shared`: матрица RBAC.
- `apps/panel`: интеграционные тесты API через `app.inject` на PGlite с реальными миграциями (`src/test/harness.ts`).
- `apps/web`: паритет ключей ru/en, перевод всех кодов ошибок API.
- `installer/tests`: bats.

## Образ

```bash
docker build -f docker/panel.Dockerfile -t truckpanel/panel:local .
```

Production-стек: `docker/compose.yaml` (postgres + panel; panel только на `127.0.0.1:${PANEL_PORT}`). Образ собирает установщик; для локальной сборки через compose добавьте `-f docker/compose.build.yaml`.

## Установщик

```bash
corepack pnpm test:installer          # bats, работает и в Git Bash
corepack pnpm test:installer:docker   # shellcheck + bats + dry-run в ubuntu/debian контейнерах
```

Подробности в `docs/features/installer.md`. Деструктивные сценарии запускаются только на одноразовых VM, никогда на рабочем VPS.
