# Discord Incoming Webhooks

Дата проверки: 2026-10-05

## Источники

- https://docs.discord.com/developers/resources/webhook (старый адрес `discord.com/developers/docs/...` редиректит сюда)
- https://docs.discord.com/developers/topics/rate-limits

## Факты

- Создание: `POST /webhooks/{id}/{token}?wait=true`. С `wait=true` ответ содержит созданное сообщение и его `id`.
- Редактирование: `PATCH /webhooks/{id}/{token}/messages/{message_id}`.
- Чтение: `GET .../messages/{message_id}`. Удаление: `DELETE .../messages/{message_id}`.
- Не больше 10 embeds в сообщении.
- Rate limit: заголовки `X-RateLimit-Limit`, `-Remaining`, `-Reset`, `-Reset-After`, `-Bucket`, `-Global`, `-Scope`. Ответ 429 содержит `retry_after` (в секундах) и `global`.
- Бакеты считаются отдельно для каждого top-level ресурса, в том числе `webhook_id`. Значит, два сервера с одинаковым webhook делят один бакет.
- Лимит невалидных запросов: 10 000 ответов 401/403/429 за 10 минут, дальше бан на уровне Cloudflare.

## Решения

- `message_id` хранится **на сервер** (`discord_integrations.server_id`), а не на URL. Одинаковые URL у двух серверов дают два отдельных сообщения (требование владельца).
- Лимитер в памяти ключуется по `webhook_id`. Учитывает `X-RateLimit-Remaining` и `Reset-After`, при 429 ждёт `retry_after`.
- PATCH вернул 404: сообщение удалили, сбрасываем `message_id` и создаём новое (как в старом мониторе).
- PATCH или POST вернул 401/403/404 на сам webhook: интеграция переходит в `ERROR`, автоповторы прекращаются, в UI объяснение. Так не копим невалидные запросы.
- Экспоненциальный backoff на 5xx и сетевые ошибки.
- URL шифруется AES-256-GCM, в логах только `webhook_id` (без токена).
- SSRF: принимаем только `https://discord.com/api/webhooks/...` и `https://discordapp.com/api/webhooks/...` (тот же regex, что в старом скрипте). Запросы идут только на `discord.com`.
- Embed берём из старого монитора: статус, игроки N/128, карта, DLC и моды из лога, подсказка про `g_max_convoy_size`. Без ссылок на Яндекс.Диск.

## Дополнение (2026-10-06, фаза 6)

Источники: https://docs.discord.com/developers/topics/opcodes-and-status-codes, https://docs.discord.com/developers/resources/message

- JSON-коды ошибок: `10008` Unknown message (сообщение удалили — создаём новое), `10015` Unknown webhook и `50027` Invalid webhook token (вебхук удалён или токен неверный — интеграция в ERROR, повторы прекращаются).
- Лимиты embed: title 256, description 4096, до 25 полей, имя поля 256, значение поля 1024, footer 2048. Сумма title/description/полей/footer по всем embed в сообщении — не больше 6000 символов.
- Ники игроков приходят из лога и могут содержать markdown и `@everyone`. Поэтому markdown экранируем, а в запрос добавляем `allowed_mentions: { parse: [] }`.
