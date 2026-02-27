# Onboarding Design: Chat Welcome Message + Viral Button

**Date:** 2026-02-27
**Goal:** Convert new chat additions into active users and drive organic growth
**Approach:** A — single welcome message with instructions + "Add to your chat" button

---

## Trigger

Listen to `my_chat_member` event. Fire only when bot status transitions to
`member` or `administrator` from `left` or `kicked`.

Ignore: re-promotions, demotions, status changes within existing member state.

---

## Welcome Message

Sent to the group chat immediately on join:

```
👋 Привет! Я автоматически исправляю ссылки соцсетей,
чтобы они показывали превью прямо в чате.

Поддерживаю: Instagram, TikTok, Twitter/X, Reddit,
Bluesky, Pixiv, DeviantArt

⚙️ Для удаления оригинального сообщения со сломанной
ссылкой нужны права администратора → «Удаление сообщений»

Используй меня в инлайн-режиме: @transform_inst_link_bot <ссылка>
```

**Inline keyboard:** one button — `➕ Добавить в свой чат`
URL: `https://t.me/transform_inst_link_bot?startgroup=true`

---

## Implementation

- Handler: `bot.on('my_chat_member', ...)`
- Check: `update.new_chat_member.status` is `member` or `administrator`
  AND `update.old_chat_member.status` is `left` or `kicked`
- Send message with `parse_mode: 'HTML'` (or plain text) + `reply_markup`
- No DM to the user who added the bot (keep it simple)
- No permission check (handled naturally — bot will just not delete messages)

---

## Out of Scope

- DM to the admin who added the bot
- Permission check with in-message warning
- Multi-step onboarding flow
- Analytics on how many chats convert via the button
