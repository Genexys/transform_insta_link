# Premium Chat Features Design

**Date:** 2026-02-27
**Goal:** Give premium users tangible value in group chats, strengthen donation motivation
**Approach:** Chat-level premium activated by any premium admin

---

## Premium Model

Premium is per-user (donation via /donate → Telegram Stars). A chat gains premium
features when a premium user who is an admin of that chat runs /settings.

No separate chat purchase. One donation = premium everywhere you are admin.

---

## Database Changes

New table:
```sql
CREATE TABLE chat_settings (
  chat_id BIGINT PRIMARY KEY,
  is_premium BOOLEAN DEFAULT FALSE,
  quiet_mode BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);
```

Extend link_events:
```sql
ALTER TABLE link_events ADD COLUMN chat_id BIGINT;
ALTER TABLE link_events ADD COLUMN user_id BIGINT;
```

---

## Feature A: /chatstats

**Who:** Premium chats only, admin only
**Command:** `/chatstats` in the group chat

Response (last 7 days):
```
📊 Статистика чата за 7 дней

Всего исправлено: 142 ссылки
📸 Instagram: 89 (63%)
🎵 TikTok: 31 (22%)
🐦 Twitter: 14 (10%)
🟠 Reddit: 8 (5%)

🏆 Самые активные:
1. @username1 — 38 ссылок
2. @username2 — 27 ссылок
3. @username3 — 19 ссылок
```

Requires `chat_id` and `user_id` in `link_events`.

---

## Feature B: Quiet Mode

**Who:** Premium chats, toggled via /settings
**Effect:** Bot sends only the fixed URL — no "Saved @user a click" prefix.
Original message is still deleted (if bot has delete_messages permission).

Normal mode:
```
Saved @user a click (📸 Instagram):

https://instafix-.../reel/...
```

Quiet mode:
```
https://instafix-.../reel/...
```

Implementation: load `chat_settings` row before sending message reply;
branch on `quiet_mode` flag.

---

## Feature C: /settings

**Who:** Admin only in group chats

If admin is NOT premium:
> "⚙️ Настройки доступны premium-пользователям. Поддержи проект → /donate"

If admin IS premium → chat is marked `is_premium = true` in `chat_settings`,
then inline keyboard is shown:

```
⚙️ Настройки чата  [Premium ✨]

🔇 Тихий режим: выкл   [Включить]
```

Toggling quiet_mode updates `chat_settings` via callback_query handler.

---

## Out of Scope

- Per-platform enable/disable toggles (can be added later on top of chat_settings)
- Subscription model (one-time donation is sufficient for now)
- Stats visible to all members (admin-only keeps it clean)
