---
"@a11ign/control": patch
---

The gate heartbeat reads the chairman's file in the shape it really has. `telegram-chairman` is `{"chatId":<n>,"userId":<n>,"pairedAt":"<iso>"}`, not a bare number, and the first install sent that whole object as `chat_id`: the unit saw the outage (`stale (last tick 10 min old)`) and Telegram answered HTTP 400, so nothing reached the chairman. A bare number still reads; JSON with no numeric `chatId` is `no route`, naming the file. Row: a11ign/a11ign#3851.
