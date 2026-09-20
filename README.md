# chat_with_actor

AI actor-avatar chat server for Flix1. Node.js / Express + MongoDB, model = DeepSeek (`deepseek-flash`).

- Persona = the **Korean** `description` of the actress in `actress_new` (other languages there are machine translations and are never sent to the model) plus name / birth / height / debut. The persona message is identical for every user of the same actress, so the provider's prefix cache applies. The chat language is a separate short message.
- Identity = the user's account token, verified against `https://<host>/api/user/profile` (same call the support ChatServer uses). `<host>` comes from the `x-auth-host` header and must be in `AUTH_PROFILE_HOSTS`.
- Chat is a paid feature: the account's `sub_expires_at` (epoch ms) from the same `/profile` call must be in the future, otherwise creating a conversation or sending is refused with `403 MEMBERSHIP_REQUIRED` (no admin exception). Identity is cached 10 minutes, but "no membership" is never served from cache: it is re-checked live on every attempt, so a user who just subscribed gets in immediately. Reading or deleting old conversations stays open.
- Only actresses whose Korean description has at least `MIN_DESCRIPTION_CHARS` (300) characters can be chatted with.
- Text only for now (no image / document upload).

## Run

```bash
cp .env.example .env   # fill MONGODB_URI, DEEPSEEK_API_KEY
npm install
npm start              # PORT (default 8004)
npm test
```

Deploy (server 172.104.71.28, next to `www`): `git pull && npm install && pm2 start src/server.js --name chat-ai` (`pm2 restart chat-ai` after that).
nginx: proxy `location /chat-ai/ { proxy_pass http://127.0.0.1:8004; }` on the same API domains, so the app needs no new domain.

## API (all under `/chat-ai`, all need `Authorization: Bearer <token>` except `/health`)

| Method / path | Purpose |
|---|---|
| `GET /health` | liveness |
| `GET /actress/:personId/status` | `{chattable, membership_active, conversation_id}` for the Chat button: the app opens the chat when both flags are true, shows the subscribe popup when `membership_active` is false (`chattable` is false when the Korean description is too short) |
| `GET /conversations` | chat list, newest first |
| `POST /conversations` `{person_id}` | get-or-create the one conversation with that actress (403 `MEMBERSHIP_REQUIRED`, 409 `NO_PROFILE` if not chattable) |
| `GET /conversations/:id/messages?limit=30&before=<messageId>` | history, oldest first |
| `POST /conversations/:id/messages` `{text, lang}` | send; returns `{user_message, reply}`. `lang` = app locale (`en ko ja zh zh-tw id ms ru th vi`) |
| `DELETE /conversations/:id` | delete conversation and its messages |

Errors: `LOGIN_REQUIRED` 401, `MEMBERSHIP_REQUIRED` 403, `AUTH_UNAVAILABLE` 502 (account server unreachable), `NO_PROFILE` 409, `BUSY` 429 (one call per conversation at a time), `DAILY_LIMIT` 429, `MESSAGE_TOO_LONG` 400, `MODEL_UNAVAILABLE` 502.

Collections written: `actor_chat_conversations`, `actor_chat_messages`, `actor_chat_usage` (daily counter, auto-expires). `actress_new` is read-only here.
