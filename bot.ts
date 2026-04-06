import 'dotenv/config';
import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import type { ChatMember } from 'node-telegram-bot-api';
import {
  ACTION_DELETE_CHECK_INTERVAL_MS,
  ACTION_DELETE_DELAY_MS,
  ACTION_DELETE_MAX_ATTEMPTS,
  ALLOWED_CHAT_IDS,
  INSTA_FIX_DOMAIN,
  INSTA_FIX_FALLBACK,
  MAX_MEDIA_GROUP_ITEMS,
  MAX_MEDIA_GROUP_TOTAL_BYTES,
  MAX_SINGLE_FILE_BYTES,
  MAX_VIDEO_BYTES,
  TELEGRAM_CAPTION_LIMIT,
  TELEGRAM_TEXT_LIMIT,
} from './src/config';
import { isInstagramLinkCandidate, replaceTransformedLinkInText } from './src/linkTransform';

const token = process.env.BOT_TOKEN;

if (!token) {
  throw new Error('BOT_TOKEN is not set');
}

const bot = new TelegramBot(token, { polling: true });

const app = express();
const port = process.env.PORT || 3000;

app.get('/', (_, res) => {
  res.json({
    ok: true,
    service: 'transform_insta_link',
    uptimeSec: Math.round(process.uptime()),
    primaryDomain: INSTA_FIX_DOMAIN,
    fallbackDomain: INSTA_FIX_FALLBACK,
    allowedChatsConfigured: ALLOWED_CHAT_IDS.size > 0,
  });
});

app.listen(port, () => {
  console.log('[startup] HTTP server listening', {
    port,
    primaryDomain: INSTA_FIX_DOMAIN,
    fallbackDomain: INSTA_FIX_FALLBACK,
    allowedChatIdsCount: ALLOWED_CHAT_IDS.size,
    nodeEnv: process.env.NODE_ENV || 'development',
  });
});


const usersWaitingForCaption = new Set<number>();

type PendingAction = {
  timeout: NodeJS.Timeout;
  chatId: number;
  replyMessageId: number;
  requestMessageId: number;
};

const pendingDeleteActions = new Map<string, PendingAction>();
const callbackProcessing = new Set<string>();

type PendingDeletedMedia = {
  media: TelegramBot.InputMedia[];
  sourceMessageId: number;
};

const pendingDeletedMediaByUser = new Map<number, PendingDeletedMedia>();

const pendingDeletedMediaGroups = new Map<string, TelegramBot.Message[]>();
const pendingDeletedMediaGroupTimers = new Map<string, NodeJS.Timeout>();

function normalizeCaptionText(input: string): string {
  return input.replace(/\r\n/g, '\n').trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getCaptionPreview(caption: string): string {
  const normalized = normalizeCaptionText(caption);

  if (!normalized) {
    return 'No caption';
  }

  const oneLine = normalized.replace(/\s+/g, ' ');
  const limit = 40;

  return oneLine.length > limit ? `${oneLine.slice(0, limit - 1)}…` : oneLine;
}

function buildRestoreButtonText(caption: string): string {
  const preview = getCaptionPreview(caption);
  return `↩️ Restore deleted post (${preview})`;
}

function cloneReplyMarkup(
  markup?: TelegramBot.InlineKeyboardMarkup,
): TelegramBot.InlineKeyboardMarkup | undefined {
  if (!markup) {
    return undefined;
  }

  return {
    inline_keyboard: markup.inline_keyboard.map((row) =>
      row.map((button) => ({ ...button })),
    ),
  };
}

function buildRestoreReplyMarkup(caption: string): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        {
          text: buildRestoreButtonText(caption),
          callback_data: 'restore_deleted_media',
        },
      ],
    ],
  };
}

async function deleteMessageIfPossible(
  chatId: number,
  messageId: number,
): Promise<void> {
  try {
    await bot.deleteMessage(chatId, messageId);
  } catch (error) {
    if (error instanceof Error && error.message.includes('message to delete not found')) {
      return;
    }

    throw error;
  }
}

async function tryDeleteMessageWithRetry(
  chatId: number,
  messageId: number,
): Promise<boolean> {
  for (let attempt = 0; attempt < ACTION_DELETE_MAX_ATTEMPTS; attempt += 1) {
    try {
      await deleteMessageIfPossible(chatId, messageId);
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes('message can\'t be deleted for everyone') ||
          error.message.includes('message can\'t be deleted'))
      ) {
        return false;
      }

      if (attempt === ACTION_DELETE_MAX_ATTEMPTS - 1) {
        throw error;
      }

      await delay(ACTION_DELETE_CHECK_INTERVAL_MS);
    }
  }

  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isTelegramForbiddenError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('403');
}

function isTelegramBadRequestError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('400');
}

function isInputMediaPhoto(item: TelegramBot.InputMedia): item is TelegramBot.InputMediaPhoto {
  return item.type === 'photo';
}

function isInputMediaVideo(item: TelegramBot.InputMedia): item is TelegramBot.InputMediaVideo {
  return item.type === 'video';
}

function getBestPhotoSize(
  photoSizes?: TelegramBot.PhotoSize[],
): TelegramBot.PhotoSize | undefined {
  if (!photoSizes?.length) {
    return undefined;
  }

  return [...photoSizes].sort((a, b) => {
    const areaA = (a.width || 0) * (a.height || 0);
    const areaB = (b.width || 0) * (b.height || 0);
    return areaB - areaA;
  })[0];
}

function getMessageCaption(message: TelegramBot.Message): string {
  return normalizeCaptionText(message.caption || '');
}

function truncateCaptionForTelegram(text: string): string {
  if (text.length <= TELEGRAM_CAPTION_LIMIT) {
    return text;
  }

  return `${text.slice(0, TELEGRAM_CAPTION_LIMIT - 1)}…`;
}

function truncateTextForTelegram(text: string): string {
  if (text.length <= TELEGRAM_TEXT_LIMIT) {
    return text;
  }

  return `${text.slice(0, TELEGRAM_TEXT_LIMIT - 1)}…`;
}

function buildDeleteActionKey(chatId: number, replyMessageId: number): string {
  return `${chatId}:${replyMessageId}`;
}

function clearPendingDeleteAction(chatId: number, replyMessageId: number): PendingAction | undefined {
  const key = buildDeleteActionKey(chatId, replyMessageId);
  const pendingAction = pendingDeleteActions.get(key);

  if (pendingAction) {
    clearTimeout(pendingAction.timeout);
    pendingDeleteActions.delete(key);
  }

  return pendingAction;
}

async function answerCallbackQuery(
  callbackQueryId: string,
  options?: Omit<TelegramBot.AnswerCallbackQueryOptions, 'callback_query_id'>,
): Promise<void> {
  try {
    await bot.answerCallbackQuery({
      callback_query_id: callbackQueryId,
      ...(options || {}),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes('query is too old') ||
        error.message.includes('query ID is invalid'))
    ) {
      return;
    }

    throw error;
  }
}

async function safelyDeleteActionMessage(
  chatId: number,
  replyMessageId: number,
): Promise<void> {
  try {
    await deleteMessageIfPossible(chatId, replyMessageId);
  } catch (error) {
    if (isTelegramForbiddenError(error) || isTelegramBadRequestError(error)) {
      return;
    }

    throw error;
  }
}

async function promptDeleteAction(
  chatId: number,
  requestMessageId: number,
  sourceMessageId: number,
): Promise<void> {
  clearPendingDeleteAction(chatId, requestMessageId);

  const sentMessage = await bot.sendMessage(chatId, 'Delete original message?', {
    reply_to_message_id: requestMessageId,
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🗑️ Delete', callback_data: `delete_original:${sourceMessageId}` },
          { text: 'Keep', callback_data: 'keep_original' },
        ],
      ],
    },
  });

  const timeout = setTimeout(() => {
    void safelyDeleteActionMessage(chatId, sentMessage.message_id);
    pendingDeleteActions.delete(buildDeleteActionKey(chatId, sentMessage.message_id));
  }, ACTION_DELETE_DELAY_MS);

  pendingDeleteActions.set(buildDeleteActionKey(chatId, sentMessage.message_id), {
    timeout,
    chatId,
    replyMessageId: sentMessage.message_id,
    requestMessageId,
  });
}

function getAllowedChatId(message: TelegramBot.Message): number | null {
  if (ALLOWED_CHAT_IDS.size === 0) {
    return message.chat.id;
  }

  return ALLOWED_CHAT_IDS.has(message.chat.id) ? message.chat.id : null;
}

async function canDeleteMessages(chatId: number): Promise<boolean> {
  try {
    const admins = await bot.getChatAdministrators(chatId);
    const me = await bot.getMe();
    const botMember = admins.find((member) => member.user.id === me.id);

    return Boolean(
      botMember &&
        ('can_delete_messages' in botMember ? botMember.can_delete_messages : false),
    );
  } catch (error) {
    console.error('Failed to check bot permissions', error);
    return false;
  }
}


async function safelyEditMessageText(
  chatId: number,
  messageId: number,
  text: string,
  options: TelegramBot.EditMessageTextOptions,
): Promise<void> {
  try {
    await bot.editMessageText(text, {
      ...options,
      chat_id: chatId,
      message_id: messageId,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('message is not modified')) {
      return;
    }

    throw error;
  }
}

async function getBotMember(chatId: number): Promise<ChatMember | null> {
  try {
    const me = await bot.getMe();
    return await bot.getChatMember(chatId, me.id);
  } catch (error) {
    console.error('Failed to get bot chat member', error);
    return null;
  }
}

function canManageMessages(member: ChatMember | null): boolean {
  if (!member) {
    return false;
  }

  if (member.status === 'administrator') {
    return Boolean(
      'can_delete_messages' in member ? member.can_delete_messages : false,
    );
  }

  return member.status === 'creator';
}

async function sendTransformedResponse(
  message: TelegramBot.Message,
  transformedText: string,
): Promise<void> {
  const chatId = message.chat.id;
  const originalText = message.text || message.caption || '';
  const shouldAttemptDelete = canManageMessages(await getBotMember(chatId));

  if (shouldAttemptDelete) {
    try {
      const deleted = await tryDeleteMessageWithRetry(chatId, message.message_id);

      if (deleted) {
        await bot.sendMessage(chatId, transformedText, {
          disable_web_page_preview: false,
        });
        return;
      }
    } catch (error) {
      console.error('Failed to delete original message', error);
    }
  }

  if (message.text) {
    try {
      await safelyEditMessageText(chatId, message.message_id, transformedText, {
        disable_web_page_preview: false,
      });
      return;
    } catch (error) {
      console.error('Failed to edit text message', error);
    }
  }

  await bot.sendMessage(chatId, transformedText, {
    reply_to_message_id: message.message_id,
    disable_web_page_preview: false,
  });

  if (originalText !== transformedText) {
    void promptDeleteAction(chatId, message.message_id, message.message_id);
  }
}

function toInputMediaFromMessage(
  message: TelegramBot.Message,
  caption?: string,
): TelegramBot.InputMedia | null {
  if (message.photo?.length) {
    const bestPhoto = getBestPhotoSize(message.photo);

    if (!bestPhoto?.file_id) {
      return null;
    }

    return {
      type: 'photo',
      media: bestPhoto.file_id,
      ...(caption ? { caption: truncateCaptionForTelegram(caption) } : {}),
    };
  }

  if (message.video?.file_id) {
    return {
      type: 'video',
      media: message.video.file_id,
      ...(caption ? { caption: truncateCaptionForTelegram(caption) } : {}),
    };
  }

  return null;
}

async function sendMediaWithCaption(
  chatId: number,
  media: TelegramBot.InputMedia[],
  caption: string,
  replyToMessageId?: number,
): Promise<TelegramBot.Message[]> {
  const normalizedCaption = normalizeCaptionText(caption);
  const clonedMedia = media.map((item, index) => {
    const clonedItem: TelegramBot.InputMedia = { ...item };

    if (index === 0 && normalizedCaption) {
      clonedItem.caption = truncateCaptionForTelegram(normalizedCaption);
    } else {
      delete clonedItem.caption;
    }

    return clonedItem;
  });

  if (clonedMedia.length === 1) {
    const [item] = clonedMedia;

    if (isInputMediaPhoto(item)) {
      const sentMessage = await bot.sendPhoto(chatId, item.media, {
        caption: item.caption,
        reply_to_message_id: replyToMessageId,
      });
      return [sentMessage];
    }

    if (isInputMediaVideo(item)) {
      const sentMessage = await bot.sendVideo(chatId, item.media, {
        caption: item.caption,
        reply_to_message_id: replyToMessageId,
      });
      return [sentMessage];
    }
  }

  const sentMessages = await bot.sendMediaGroup(chatId, clonedMedia, {
    reply_to_message_id: replyToMessageId,
  });

  return Array.isArray(sentMessages) ? sentMessages : [sentMessages];
}

async function sendMediaRestorePrompt(
  chatId: number,
  requestMessageId: number,
  caption: string,
): Promise<void> {
  await bot.sendMessage(chatId, 'Deleted post saved. Tap below to restore it with the same caption.', {
    reply_to_message_id: requestMessageId,
    reply_markup: buildRestoreReplyMarkup(caption),
  });
}

function getMediaFileSizeBytes(message: TelegramBot.Message): number | undefined {
  if (message.photo?.length) {
    return getBestPhotoSize(message.photo)?.file_size;
  }

  if (message.video) {
    return message.video.file_size;
  }

  return undefined;
}

function mediaExceedsSupportedLimit(message: TelegramBot.Message): boolean {
  if (message.video && (message.video.file_size || 0) > MAX_VIDEO_BYTES) {
    return true;
  }

  const fileSize = getMediaFileSizeBytes(message);
  return typeof fileSize === 'number' && fileSize > MAX_SINGLE_FILE_BYTES;
}

function mediaGroupExceedsSupportedLimit(messages: TelegramBot.Message[]): boolean {
  let totalBytes = 0;

  for (const item of messages) {
    const fileSize = getMediaFileSizeBytes(item);

    if (typeof fileSize === 'number') {
      totalBytes += fileSize;
    }
  }

  return totalBytes > MAX_MEDIA_GROUP_TOTAL_BYTES;
}

function sortMediaGroupMessages(messages: TelegramBot.Message[]): TelegramBot.Message[] {
  return [...messages].sort((a, b) => a.message_id - b.message_id);
}

async function handleDeletedMediaRestore(callbackQuery: TelegramBot.CallbackQuery): Promise<void> {
  const callbackMessage = callbackQuery.message;
  const fromUser = callbackQuery.from;

  if (!callbackMessage || !fromUser) {
    return;
  }

  const pendingMedia = pendingDeletedMediaByUser.get(fromUser.id);

  if (!pendingMedia) {
    await answerCallbackQuery(callbackQuery.id, {
      text: 'No deleted post found to restore.',
      show_alert: true,
    });
    return;
  }

  try {
    await sendMediaWithCaption(
      callbackMessage.chat.id,
      pendingMedia.media,
      getMessageCaption(callbackMessage),
      callbackMessage.message_id,
    );
    await answerCallbackQuery(callbackQuery.id, {
      text: 'Post restored.',
    });
  } catch (error) {
    console.error('Failed to restore deleted media', error);
    await answerCallbackQuery(callbackQuery.id, {
      text: 'Failed to restore post.',
      show_alert: true,
    });
    return;
  }

  pendingDeletedMediaByUser.delete(fromUser.id);

  try {
    await safelyDeleteActionMessage(callbackMessage.chat.id, callbackMessage.message_id);
  } catch (error) {
    console.error('Failed to delete restore prompt', error);
  }
}

async function sendMediaCaptionPrompt(
  message: TelegramBot.Message,
): Promise<void> {
  const sentMessage = await bot.sendMessage(
    message.chat.id,
    'I saved the post. Send me a caption in your next message and I will repost it.',
    {
      reply_to_message_id: message.message_id,
    },
  );

  void promptDeleteAction(message.chat.id, sentMessage.message_id, message.message_id);
}

async function handleSingleMediaDeletion(message: TelegramBot.Message): Promise<boolean> {
  const inputMedia = toInputMediaFromMessage(message);

  if (!inputMedia) {
    return false;
  }

  if (mediaExceedsSupportedLimit(message)) {
    await bot.sendMessage(
      message.chat.id,
      'This media file is too large for me to restore. Telegram only allows files up to 49 MB in this flow.',
      {
        reply_to_message_id: message.message_id,
      },
    );
    return false;
  }

  try {
    const deleted = await tryDeleteMessageWithRetry(message.chat.id, message.message_id);

    if (!deleted) {
      return false;
    }
  } catch (error) {
    console.error('Failed to delete media message', error);
    return false;
  }

  pendingDeletedMediaByUser.set(message.from?.id || 0, {
    media: [inputMedia],
    sourceMessageId: message.message_id,
  });
  usersWaitingForCaption.add(message.from?.id || 0);

  await sendMediaCaptionPrompt(message);
  return true;
}

async function handleMediaGroupDeletion(message: TelegramBot.Message): Promise<void> {
  const mediaGroupId = message.media_group_id;
  const chatId = message.chat.id;

  if (!mediaGroupId) {
    return;
  }

  const existingMessages = pendingDeletedMediaGroups.get(mediaGroupId) || [];
  existingMessages.push(message);
  pendingDeletedMediaGroups.set(mediaGroupId, existingMessages);

  const existingTimer = pendingDeletedMediaGroupTimers.get(mediaGroupId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const timer = setTimeout(() => {
    void (async () => {
      const groupedMessages = pendingDeletedMediaGroups.get(mediaGroupId);
      pendingDeletedMediaGroups.delete(mediaGroupId);
      pendingDeletedMediaGroupTimers.delete(mediaGroupId);

      if (!groupedMessages?.length) {
        return;
      }

      const sortedMessages = sortMediaGroupMessages(groupedMessages);
      const inputMedia = sortedMessages
        .slice(0, MAX_MEDIA_GROUP_ITEMS)
        .map((item, index) =>
          toInputMediaFromMessage(item, index === 0 ? getMessageCaption(item) : undefined),
        )
        .filter((item): item is TelegramBot.InputMedia => Boolean(item));

      if (!inputMedia.length) {
        return;
      }

      if (mediaGroupExceedsSupportedLimit(sortedMessages)) {
        await bot.sendMessage(
          chatId,
          'This media group is too large for me to restore. Telegram only allows up to 49 MB total in this flow.',
          {
            reply_to_message_id: sortedMessages[0].message_id,
          },
        );
        return;
      }

      try {
        for (const item of sortedMessages) {
          await tryDeleteMessageWithRetry(chatId, item.message_id);
        }
      } catch (error) {
        console.error('Failed to delete media group', error);
        return;
      }

      pendingDeletedMediaByUser.set(sortedMessages[0].from?.id || 0, {
        media: inputMedia,
        sourceMessageId: sortedMessages[0].message_id,
      });
      usersWaitingForCaption.add(sortedMessages[0].from?.id || 0);
      await sendMediaCaptionPrompt(sortedMessages[0]);
    })();
  }, 500);

  pendingDeletedMediaGroupTimers.set(mediaGroupId, timer);
}

bot.on('callback_query', async (callbackQuery) => {
  const callbackMessage = callbackQuery.message;
  const callbackData = callbackQuery.data;

  if (!callbackMessage || !callbackData) {
    return;
  }

  const callbackKey = `${callbackMessage.chat.id}:${callbackMessage.message_id}:${callbackQuery.id}`;
  if (callbackProcessing.has(callbackKey)) {
    return;
  }

  callbackProcessing.add(callbackKey);

  try {
    if (callbackData === 'restore_deleted_media') {
      await handleDeletedMediaRestore(callbackQuery);
      return;
    }

    const pendingAction = clearPendingDeleteAction(
      callbackMessage.chat.id,
      callbackMessage.message_id,
    );

    if (!pendingAction) {
      await answerCallbackQuery(callbackQuery.id, {
        text: 'This action is no longer available.',
        show_alert: true,
      });
      return;
    }

    if (callbackData.startsWith('delete_original:')) {
      const sourceMessageId = Number.parseInt(
        callbackData.split(':')[1],
        10,
      );

      if (!Number.isInteger(sourceMessageId)) {
        await answerCallbackQuery(callbackQuery.id, {
          text: 'Invalid delete action.',
          show_alert: true,
        });
        return;
      }

      try {
        await deleteMessageIfPossible(callbackMessage.chat.id, sourceMessageId);
        await answerCallbackQuery(callbackQuery.id, {
          text: 'Original message deleted.',
        });
      } catch (error) {
        console.error('Failed to delete original message from callback', error);
        await answerCallbackQuery(callbackQuery.id, {
          text: 'Failed to delete original message.',
          show_alert: true,
        });
      }
    } else if (callbackData === 'keep_original') {
      await answerCallbackQuery(callbackQuery.id, {
        text: 'Keeping original message.',
      });
    } else {
      await answerCallbackQuery(callbackQuery.id, {
        text: 'Unknown action.',
        show_alert: true,
      });
      return;
    }

    await safelyDeleteActionMessage(callbackMessage.chat.id, callbackMessage.message_id);
  } catch (error) {
    console.error('Failed to process callback query', error);
  } finally {
    callbackProcessing.delete(callbackKey);
  }
});

bot.on('message', async (message) => {
  const allowedChatId = getAllowedChatId(message);

  if (!allowedChatId) {
    return;
  }

  const me = await bot.getMe();

  if (message.new_chat_members?.some((member) => member.id === me.id)) {
    const hasDeletePermission = await canDeleteMessages(message.chat.id);

    if (!hasDeletePermission) {
      await bot.sendMessage(
        message.chat.id,
        'Hi! Please make me an admin with Delete messages permission so I can replace Instagram links properly.',
      );
    }
    return;
  }

  if (message.text?.startsWith('/start')) {
    await bot.sendMessage(message.chat.id, 'Send me a message with an Instagram link and I will replace it.', {
      reply_to_message_id: message.message_id,
    });
    return;
  }

  if (message.text?.startsWith('/captionreset')) {
    if (message.from?.id) {
      usersWaitingForCaption.delete(message.from.id);
      pendingDeletedMediaByUser.delete(message.from.id);
    }

    await bot.sendMessage(message.chat.id, 'Caption input reset.', {
      reply_to_message_id: message.message_id,
    });
    return;
  }

  if (message.media_group_id && (message.photo?.length || message.video)) {
    await handleMediaGroupDeletion(message);
    return;
  }

  if (message.photo?.length || message.video) {
    const handled = await handleSingleMediaDeletion(message);
    if (handled) {
      return;
    }
  }

  if (message.from?.id && usersWaitingForCaption.has(message.from.id) && message.text) {
    const pendingMedia = pendingDeletedMediaByUser.get(message.from.id);

    if (!pendingMedia) {
      usersWaitingForCaption.delete(message.from.id);
      return;
    }

    try {
      await sendMediaWithCaption(
        message.chat.id,
        pendingMedia.media,
        message.text,
        message.message_id,
      );
      await sendMediaRestorePrompt(message.chat.id, message.message_id, message.text);
      usersWaitingForCaption.delete(message.from.id);
      pendingDeletedMediaByUser.delete(message.from.id);
    } catch (error) {
      console.error('Failed to resend deleted media with caption', error);
      await bot.sendMessage(
        message.chat.id,
        'Failed to repost the deleted post. Please try again.',
        {
          reply_to_message_id: message.message_id,
        },
      );
    }
    return;
  }

  const content = message.text || message.caption || '';

  if (!content || !isInstagramLinkCandidate(content)) {
    return;
  }

  const transformedText = replaceTransformedLinkInText(content);

  if (!transformedText || transformedText === content) {
    return;
  }

  try {
    await sendTransformedResponse(message, transformedText);
  } catch (error) {
    console.error('Failed to transform Instagram link', error);
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[fatal] uncaughtException', error);
});

console.log('[startup] Telegram bot polling started');
