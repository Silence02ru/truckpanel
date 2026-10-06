# Аутентификация, сессии, RBAC

## Назначение

Вход в панель, создание первого администратора, серверные сессии, проверка прав на каждом маршруте.

## Архитектура

- Пароли: argon2id (`@node-rs/argon2`), m=19 MiB, t=2, p=1 (минимум по OWASP Password Storage Cheat Sheet).
- Сессия: случайные 256 бит в httpOnly-cookie `tp_session` (`SameSite=Lax`, `Secure` при https). В БД хранится только SHA-256. Срок жизни 7 дней, `last_seen_at` обновляется не чаще раза в 5 минут.
- Сессия недействительна, если она отозвана, истекла или пользователь отключён (проверяется на каждом запросе).
- CSRF: double-submit cookie `tp_csrf` (читается SPA) и заголовок `X-CSRF-Token` на всех POST/PUT/PATCH/DELETE под `/api/`. Плюс `Origin`, если он есть, должен совпадать с `APP_URL`.
- RBAC: роль хранится в `users.role`, матрица прав в коде (`packages/shared/src/permissions.ts`). В роуте: `preHandler: requirePermission('server.power')`.
- Первый администратор: `INITIAL_SETUP_TOKEN` из `.env` (генерирует установщик). Эндпоинт работает, только пока в БД нет пользователей. Гонку закрывает `pg_advisory_xact_lock`.

## Конфигурация

`APP_URL`, `INITIAL_SETUP_TOKEN`, `TRUST_PROXY_HOPS` (для `request.ip` за прокси) — см. `.env.example`.

## API

| Метод | Путь | Доступ | Описание |
|---|---|---|---|
| GET | /api/setup/status | все | `{required}`, выдаёт CSRF-cookie |
| POST | /api/setup/admin | токен установки | создать администратора и войти (5/мин) |
| GET | /api/auth/me | сессия | текущий пользователь + права, выдаёт CSRF-cookie |
| POST | /api/auth/login | все | `{login, password}`, login = имя или email без учёта регистра (10/мин) |
| POST | /api/auth/logout | все | отзывает текущую сессию |
| POST | /api/auth/logout-all | сессия | отзывает все сессии пользователя |
| GET | /api/health | все | 200 + `X-TruckPanel`, проверка БД |

OpenAPI: `/api/docs` и `/api/docs/json`.
Ошибки: `{error:{code,message}}`. Коды перечислены в `packages/shared/src/errors.ts`, UI переводит их через `errors.<code>`.

## Отказы

- Неизвестный пользователь и неверный пароль дают одинаковый ответ, время выравнивается фиктивной проверкой argon2.
- Превышение лимита: 429 `rate_limited`.
- Нет связи с БД при старте: понятное сообщение без URL и пароля, выход с кодом 1.

## Безопасность

- В аудите: `auth.login`, `auth.login_failed` (с причиной, без пароля), `auth.logout`, `auth.logout_all`, `setup.admin_created`, `setup.invalid_token`.
- Pino редактирует `cookie`, `x-csrf-token`, `set-cookie`.
- Тело запросов не логируется.

## Тесты

`apps/panel/src/auth/auth.test.ts` — 18 сценариев: setup, CSRF, Origin, вход по имени и email, одинаковые ошибки, аудит без пароля, logout, logout-all, отключённый пользователь, rate limit, RBAC 401/403/200.
`packages/shared/src/permissions.test.ts` — вложенность ролей.

## Не сделано (позже)

2FA (после v1), управление пользователями (фаза 7).
