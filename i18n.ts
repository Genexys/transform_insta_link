// User-facing copy in Russian and English. Pure (no runtime imports) so it can
// be unit-tested. `en` is typed against `ru`, so a key missing from either
// language is a compile error.
//
// Language choice:
//   - private chat: the user's Telegram client language
//   - group: the chat's `language` setting, Russian when unset (the bot's
//     existing audience), seeded from whoever adds the bot to the chat

export type Lang = 'ru' | 'en';

const RU_LIKE = new Set(['ru', 'uk', 'be', 'kk']);

// Maps a Telegram `language_code` (IETF tag such as "en", "ru", "pt-br") to a
// supported language. Unknown / missing → Russian, the historical default.
export function langFromCode(code: string | undefined | null): Lang {
  if (!code) return 'ru';
  const base = code.toLowerCase().split('-')[0];
  if (RU_LIKE.has(base)) return 'ru';
  return 'en';
}

export function normalizeLang(value: string | undefined | null): Lang | null {
  return value === 'ru' || value === 'en' ? value : null;
}

function ruPlural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return few;
  return many;
}

const enPlural = (n: number, one: string, many: string) =>
  n === 1 ? one : many;

export type MediaNoun = 'photo' | 'video';

const SUPPORTED_LIST =
  'Instagram, TikTok, Twitter/X, Reddit, Bluesky, Pixiv, DeviantArt';

const ru = {
  someone: 'кто-то',
  friend: 'Друг',
  thisBot: 'этот бот',
  genericLink: 'ссылка',
  mentionLabel: '🔔 Отметили:',
  noun: (kind: MediaNoun): string => (kind === 'photo' ? 'фото' : 'видео'),

  // The rewrite header is intentionally the same in every language for now.
  rewritePrefix: (username: string, platforms: string) =>
    `Saved ${username} a click ${platforms}:\n\n`,

  // inline mode
  inlineHintDesc: 'Введите ссылку для исправления',
  inlineHintText: '📱 Отправьте ссылку для получения рабочей версии',
  inlineNoLinksTitle: '❌ ссылки не найдены',
  inlineNoLinksDesc: 'Убедитесь что отправили правильную ссылку',
  inlineFixedCount: (n: number) => `${n} ссылок исправлено`,
  inlineVideoTitle: '🎥 Видео в чат',
  inlineVideoDesc: 'Отправить видео файлом',
  inlineErrorTitle: '⚠️ Не удалось обработать ссылку',
  inlineErrorDesc: 'Попробуйте ещё раз или отправьте ссылку боту в чат',
  inlineErrorText: 'Не удалось обработать inline query',

  // rewritten message
  downloadButton: '📥 Скачать видео/фото',
  downloadToChatButton: '📥 Скачать видео в чат',
  oversizedNote:
    '\n\n📦 Видео слишком большое для авто-превью — нажмите кнопку ниже, чтобы посмотреть в чате или сохранить себе.',
  saveButton: (kind: MediaNoun, stars: number): string =>
    kind === 'photo'
      ? `💾 Сохранить фото за ⭐${stars}`
      : `💾 Сохранить себе за ⭐${stars}`,
  deleteButton: '🗑 Удалить',
  deleteNotAllowed: '⛔ Удалить может только автор сообщения или админ чата.',
  deleteFailed: '⚠️ Не получилось удалить сообщение.',
  rightsHint:
    'ℹ️ У меня нет права «Удаление сообщений», поэтому я не заменяю сообщения со ссылками, а отвечаю на них исправленной ссылкой.\n\n' +
    'Чтобы я заменял оригинал — дайте мне это право в настройках чата. Если текущий вариант устраивает, включите «Не удалять оригинал» в /settings.\n\n' +
    'Это сообщение показывается один раз.',

  // free in-chat download
  downloadUnavailable: '📥 Скачивание временно недоступно на этом инстансе.',
  downloadLinkNotFound: '❌ Ссылка не найдена',
  downloadBusy: '⏳ Предыдущая загрузка ещё идёт, подождите.',
  downloadRateLimited: (minutes: number) =>
    `⏳ Слишком много загрузок. Попробуйте через ${minutes} мин. Безлимит: /premium`,
  downloadStarting: '⏳ Начинаю загрузку...',
  downloadLoading: '⏳ Скачиваю, это может занять несколько секунд...',
  downloadReady: '🎥 Ваше видео готово!',
  downloadErrTooBig:
    '❌ Видео слишком большое для отправки через Telegram (>50MB).',
  downloadErrPreview: (detail: string) =>
    `❌ Сервис превью вернул ошибку: ${detail}. Попробуйте через минуту.`,
  downloadErrGeneric:
    '❌ Произошла ошибка на сервере. Попробуйте позже или используйте другую ссылку.',

  // delivered media captions
  videoCaption: (premium: boolean): string =>
    premium
      ? '🎥 Ваше видео (безлимит активен) — можно сохранять.'
      : '🎥 Ваше видео — можно сохранять и пересылать.',
  photoCaption: (premium: boolean): string =>
    premium
      ? '🖼 Ваше фото (безлимит активен) — можно сохранять.'
      : '🖼 Ваше фото — можно сохранять и пересылать.',

  // invoices & payments
  invoiceDownloadTitle: (kind: MediaNoun) =>
    `Скачать ${kind === 'photo' ? 'фото' : 'видео'}`,
  invoiceDownloadDesc: (kind: MediaNoun, stars: number) =>
    `Сохраняемая копия (${kind === 'photo' ? 'фото' : 'видео'}) за ${stars} Stars. После оплаты бот пришлёт файл сюда.`,
  invoiceDownloadLabel: (kind: MediaNoun) =>
    `Скачивание (${kind === 'photo' ? 'фото' : 'видео'})`,
  invoiceDownloadError: 'Не удалось сформировать счёт на скачивание.',
  previewOnly:
    'ℹ️ Этот пост сейчас доступен только как превью — сохранить фото в полном качестве не получится. Попробуйте позже.',
  invoicePassTitle: 'Безлимит на скачивание',
  invoicePassDesc: (stars: number) =>
    `Разовая покупка — навсегда сохраняй любые видео без оплаты за каждое, в любом чате с ботом и в личке. ${stars} Stars.`,
  invoicePassLabel: 'Безлимит навсегда',
  invoicePassError: 'Не удалось сформировать счёт на безлимит.',
  invoiceDonateTitle: 'Поддержка InstaFix Bot',
  invoiceDonateDesc: (amount: number) =>
    `Добровольный донат в размере ${amount} Stars на развитие проекта.`,
  invoiceDonateLabel: 'Донат',
  invoiceDonateError: 'Произошла ошибка при формировании счета.',
  checkoutUnavailable:
    'Покупка временно недоступна. Попробуйте позже — звёзды не списаны.',
  refundDone: '↩️ Звёзды возвращены.',
  refundManual:
    'Автоматически вернуть звёзды не получилось — напишите /paysupport, вернём вручную.',
  passActivationFailed: '❌ Не удалось активировать безлимит.',
  passActivated:
    '♾️ *Безлимит активирован!*\n\n' +
    'Теперь сохраняй любые видео без оплаты — просто жми 💾 на любом ролике.\n' +
    'Работает в *любом чате, где есть бот*, и здесь, в личке с ботом.',
  passFileFailed:
    '⚠️ Безлимит активен, но этот файл отправить не удалось. Нажмите 💾 на ролике ещё раз чуть позже.',
  paidSending: '✅ Оплата получена, отправляю файл…',
  fileFailed: '❌ Не удалось отправить файл.',
  donateThanks: (username: string, amount: number) =>
    `🎉 *Спасибо большое, ${username}!*\n\n` +
    `Ваш донат в размере *${amount} Stars* успешно получен. ❤️`,

  // commands
  start:
    '👋 Привет! Я автоматически исправляю ссылки соцсетей, чтобы они показывали превью прямо в Telegram.\n\n' +
    `Поддерживаю: ${SUPPORTED_LIST}\n\n` +
    'Добавь меня в групповой чат — и я буду исправлять ссылки автоматически.',
  addToChat: '➕ Добавить в чат',
  addToOwnChat: '➕ Добавить в свой чат',
  help: (botMention: string) =>
    '🔧 Как использовать:\n\n' +
    '1. Добавьте бота в групповой чат\n' +
    '2. Дайте боту аминистраторские права для управления сообщениями (удаление и редактирование)\n' +
    '3. Когда кто-то отправит ссылку, бот автоматически отправит исправленную версию\n' +
    '4. Исправленные ссылки будут показывать нормальный предпросмотр\n' +
    `5. Вы также можете использовать меня в личных сообщениях или в режиме инлайн, вводя ${botMention} в любом чате и отправляя ссылку\n` +
    '6. Бот поддерживает ссылки на:\n' +
    '   • Instagram (посты, reels, IGTV)\n' +
    '   • X.com / Twitter\n' +
    '   • TikTok\n' +
    '   • Reddit\n' +
    '   • Bluesky\n' +
    '   • DeviantArt\n' +
    '   • Pixiv\n\n' +
    'Команды:\n' +
    '/settings — настройки чата (для админов)\n' +
    '/chatstats — статистика чата (для админов)\n' +
    '/premium — безлимит на скачивание\n' +
    '/purchases — мои покупки\n' +
    '/paysupport — помощь с оплатой\n' +
    '/terms — условия использования\n\n' +
    '🛟 Что-то сломалось? Напишите /feedback <сообщение> — пришлю разработчику.\n' +
    '❤️ Поддержать проект: /donate',
  onboarding: (botMention: string) =>
    '👋 Привет! Я автоматически исправляю ссылки соцсетей, чтобы они показывали превью прямо в чате.\n\n' +
    `Поддерживаю: ${SUPPORTED_LIST}\n\n` +
    '⚙️ Для удаления оригинального сообщения со сломанной ссылкой нужны права администратора → «Удаление сообщений»\n' +
    '🛠 Настройки чата: /settings\n\n' +
    `Используй меня в инлайн-режиме: ${botMention} <ссылка>`,
  premiumDeliveryFailed:
    '❌ Не удалось отправить файл. Попробуйте позже или /feedback.',
  passUpsell:
    'Часто качаешь? Купи безлимит — и сохраняй без оплаты за каждое видео.',
  passUpsellButton: (stars: number) => `♾️ Безлимит навсегда — ⭐${stars}`,
  premiumActive:
    '♾️ У тебя активен безлимит на скачивание — сохраняй любые видео бесплатно.',
  premiumOffer: (stars: number) =>
    `♾️ *Безлимит на скачивание*\n\n` +
    `Разовая покупка — навсегда сохраняй любые видео без оплаты за каждое.\n` +
    `Работает в любом чате, где есть бот, и в личке.\n\n` +
    `Цена: ${stars} ⭐`,
  premiumBuy: (stars: number) => `Купить за ⭐${stars}`,
  inviteLink: (url: string) => `🔗 Твоя реферальная ссылка:\n${url}\n\n`,
  inviteNoLink: '🔗 Не удалось определить ссылку бота. Попробуйте позже.\n\n',
  inviteCount: (count: number) =>
    `Ты пригласил: ${count} ${ruPlural(count, 'пользователь', 'пользователя', 'пользователей')}`,
  inviteReward: (count: number, threshold: number) =>
    `\n\n🎁 Пригласи ${threshold} новых пользователей — получи безлимит на скачивание навсегда. Прогресс: ${Math.min(count, threshold)}/${threshold}`,
  inviteRewardGranted: '\n\n🎁 Безлимит за приглашения уже активен ♾️',
  referralJoined: (count: number, threshold: number) =>
    `🎉 По твоей ссылке пришёл новый пользователь! ${Math.min(count, threshold)}/${threshold} до безлимита.`,
  referralPassGranted: (threshold: number) =>
    `♾️ Ты пригласил ${threshold} пользователей — безлимит на скачивание активирован навсегда. Спасибо!`,
  donateGroupOnly: (botMention: string) =>
    `❤️ /donate доступна в личном чате. Напишите ${botMention} в личку.`,
  // MarkdownV2: keep free of unescaped . - ! ( ) outside code spans.
  donateText:
    '❤️ *Поддержать проект*\n\n' +
    'Вы можете поддержать развитие бота с помощью *Telegram Stars* или напрямую:\n\n' +
    '💳 Тинь: `https://www.tinkoff.ru/rm/r_niFZCEvUVm.PQsrZmuYJc/pTW9A14929`\n' +
    '💳 BOG: `GE76BG0000000538914758`\n' +
    'USDT TRC20: `TYS2zFqnBjRtwTUyJjggFtQk9zrJX6T976`\n' +
    '₿ BTC: `bc1q3ezgkak8swygvgfcqgtcxyswfmt4dzeeu93vq5`\n\n' +
    'Выберите сумму в Stars ниже или воспользуйтесь реквизитами 🙏',

  // settings
  settingsGroupOnly: '⚙️ /settings работает только в групповых чатах.',
  settingsAdminsOnly: '⚙️ Настройки доступны только администраторам чата.',
  settingsAdminsOnlyAlert:
    '⛔ Только администраторы могут изменять настройки.',
  settingsTitle:
    '⚙️ Настройки чата\n\n' +
    '🔇 Тихий режим — без строки «Saved … a click»\n' +
    '📌 Не удалять оригинал — отвечать ссылкой, не заменяя сообщение\n' +
    '🖼 Альбомы — присылать карусели Instagram альбомом\n' +
    '🗑 Кнопка удаления — под сообщениями бота\n' +
    '🌐 Платформы — какие ссылки исправлять',
  settingsPlatformsTitle:
    '🌐 Платформы\n\nНажмите, чтобы включить или выключить исправление ссылок.',
  settingQuiet: '🔇 Тихий режим',
  settingKeepOriginal: '📌 Не удалять оригинал',
  settingAlbums: '🖼 Альбомы Instagram',
  settingDeleteButton: '🗑 Кнопка удаления',
  settingPlatforms: '🌐 Платформы',
  settingLanguage: '🗣 Язык',
  settingsBack: '« Назад',
  on: 'вкл',
  off: 'выкл',
  saved: '✅ Сохранено',
  saveFailed: '⚠️ Не удалось сохранить настройку.',

  // chat stats
  chatstatsGroupOnly: '📊 /chatstats работает только в групповых чатах.',
  chatstatsAdminsOnly: '📊 Статистика доступна только администраторам чата.',
  dbUnavailable: '📊 База данных недоступна.',
  chatstatsFailed: '📊 Не удалось загрузить статистику чата. Попробуйте позже.',
  chatstatsEmpty: '📊 За последние 7 дней ссылок не исправлялось.',
  chatstatsTitle: '📊 Статистика чата за 7 дней',
  chatstatsTotal: (n: number) => `Всего исправлено: ${n} ссылок`,
  chatstatsTop: '🏆 Самые активные:',
  chatstatsUserLine: (i: number, name: string, cnt: number) =>
    `${i}. ${name} — ${cnt} ссылок`,
  platformOther: '🔗 Другие',

  // feedback
  feedbackNotConfigured:
    '⚠️ Канал обратной связи не настроен. Попробуйте позже.',
  feedbackUsage:
    'ℹ️ Использование: /feedback <ваше сообщение>\n' +
    'Можно прикрепить скриншот: отправьте фото и в подписи напишите /feedback <описание>.',
  feedbackThanks: '✅ Спасибо! Сообщение отправлено разработчику.',
  feedbackFailed: '⚠️ Не удалось отправить отзыв. Попробуйте позже.',

  // payments support / terms / history
  paysupport:
    '💬 Помощь с оплатой\n\n' +
    'Оплата проходит через Telegram Stars. Если файл не пришёл или покупка не активировалась, звёзды возвращаются автоматически.\n\n' +
    'Если что-то пошло не так — напишите сюда одним сообщением:\n' +
    '/paysupport <что случилось>\n\n' +
    'Я передам обращение разработчику вместе с вашими последними платежами. Список покупок: /purchases',
  paysupportSent:
    '✅ Обращение передано разработчику. Ответ придёт в этот чат или в личные сообщения.',
  terms:
    '📄 Условия использования\n\n' +
    '1. Бот заменяет ссылки соцсетей на ссылки сторонних сервисов предпросмотра. Работа этих сервисов и самих соцсетей от бота не зависит и не гарантируется.\n' +
    '2. Платные функции оплачиваются в Telegram Stars: разовое сохранение фото или видео и «Безлимит» — разовая покупка без срока действия.\n' +
    '3. Если оплаченный файл не доставлен или покупка не активирована, звёзды возвращаются. По остальным вопросам об оплате — /paysupport.\n' +
    '4. Донаты добровольны и не возвращаются.\n' +
    '5. Вы сами отвечаете за то, как используете скачанные материалы, и за соблюдение авторских прав и правил соцсетей.\n' +
    '6. Бот хранит ваш Telegram ID, имя пользователя, историю платежей и обезличенную статистику исправленных ссылок. Тексты сообщений не сохраняются.\n' +
    '7. Сервис предоставляется «как есть»; условия могут обновляться.',
  purchasesTitle: '🧾 Последние покупки',
  purchasesEmpty: '🧾 Покупок пока нет.',
  purchasesUnavailable: '🧾 История покупок сейчас недоступна.',
  purchaseKind: (kind: string) =>
    (
      ({
        donate: 'Донат',
        download: 'Сохранение файла',
        personal_pro: 'Безлимит',
      }) as Record<string, string>
    )[kind] ?? kind,
  purchaseStatus: (status: string) =>
    (
      ({
        paid: 'оплачено',
        refunded: 'возвращено',
        refund_failed: 'ожидает возврата',
      }) as Record<string, string>
    )[status] ?? status,
};

export type Strings = typeof ru;

const en: Strings = {
  someone: 'someone',
  friend: 'Friend',
  thisBot: 'this bot',
  genericLink: 'link',
  mentionLabel: '🔔 Mentioned:',
  noun: kind => (kind === 'photo' ? 'photo' : 'video'),

  rewritePrefix: (username, platforms) =>
    `Saved ${username} a click ${platforms}:\n\n`,

  inlineHintDesc: 'Type a link to fix',
  inlineHintText: '📱 Send a link to get a working version',
  inlineNoLinksTitle: '❌ no links found',
  inlineNoLinksDesc: 'Make sure you sent a supported link',
  inlineFixedCount: n => `${n} ${enPlural(n, 'link', 'links')} fixed`,
  inlineVideoTitle: '🎥 Video to chat',
  inlineVideoDesc: 'Send the video as a file',
  inlineErrorTitle: '⚠️ Could not process the link',
  inlineErrorDesc: 'Try again or send the link to the bot directly',
  inlineErrorText: 'Could not process the inline query',

  downloadButton: '📥 Download video/photo',
  downloadToChatButton: '📥 Download video to chat',
  oversizedNote:
    '\n\n📦 The video is too large for an auto-preview — use the button below to watch it in the chat or save it.',
  saveButton: (kind, stars) =>
    kind === 'photo' ? `💾 Save photo for ⭐${stars}` : `💾 Save for ⭐${stars}`,
  deleteButton: '🗑 Delete',
  deleteNotAllowed: '⛔ Only the author or a chat admin can delete this.',
  deleteFailed: '⚠️ Could not delete the message.',
  rightsHint:
    'ℹ️ I do not have the “Delete messages” permission, so instead of replacing messages with links I reply to them with a fixed link.\n\n' +
    'To have me replace the original, grant that permission in the chat settings. If the current behaviour suits you, turn on “Keep original” in /settings.\n\n' +
    'This message is shown once.',

  downloadUnavailable: '📥 Downloads are temporarily unavailable.',
  downloadLinkNotFound: '❌ Link not found',
  downloadBusy: '⏳ Your previous download is still running, please wait.',
  downloadRateLimited: minutes =>
    `⏳ Too many downloads. Try again in ${minutes} min. Unlimited: /premium`,
  downloadStarting: '⏳ Starting download...',
  downloadLoading: '⏳ Downloading, this may take a few seconds...',
  downloadReady: '🎥 Your video is ready!',
  downloadErrTooBig: '❌ The video is too large to send via Telegram (>50MB).',
  downloadErrPreview: detail =>
    `❌ The preview service returned an error: ${detail}. Try again in a minute.`,
  downloadErrGeneric: '❌ Server error. Try again later or use another link.',

  videoCaption: premium =>
    premium
      ? '🎥 Your video (unlimited pass active) — free to save.'
      : '🎥 Your video — free to save and forward.',
  photoCaption: premium =>
    premium
      ? '🖼 Your photo (unlimited pass active) — free to save.'
      : '🖼 Your photo — free to save and forward.',

  invoiceDownloadTitle: kind => `Download ${kind}`,
  invoiceDownloadDesc: (kind, stars) =>
    `A savable copy (${kind}) for ${stars} Stars. The bot sends the file here after payment.`,
  invoiceDownloadLabel: kind => `Download (${kind})`,
  invoiceDownloadError: 'Could not create the download invoice.',
  previewOnly:
    'ℹ️ This post is currently available only as a preview — a full-quality photo cannot be saved. Try again later.',
  invoicePassTitle: 'Unlimited downloads',
  invoicePassDesc: stars =>
    `One-time purchase — save any video forever without paying for each one, in any chat with the bot and in private. ${stars} Stars.`,
  invoicePassLabel: 'Unlimited forever',
  invoicePassError: 'Could not create the unlimited pass invoice.',
  invoiceDonateTitle: 'Support InstaFix Bot',
  invoiceDonateDesc: amount =>
    `A voluntary donation of ${amount} Stars to support the project.`,
  invoiceDonateLabel: 'Donation',
  invoiceDonateError: 'Could not create the invoice.',
  checkoutUnavailable:
    'Purchases are temporarily unavailable. Try again later — no Stars were charged.',
  refundDone: '↩️ Your Stars have been refunded.',
  refundManual:
    'The automatic refund failed — write /paysupport and we will refund you manually.',
  passActivationFailed: '❌ Could not activate the unlimited pass.',
  passActivated:
    '♾️ *Unlimited pass activated!*\n\n' +
    'Save any video for free from now on — just tap 💾 on any clip.\n' +
    'Works in *any chat with the bot* and here in private.',
  passFileFailed:
    '⚠️ The pass is active, but this file could not be sent. Tap 💾 on the clip again a bit later.',
  paidSending: '✅ Payment received, sending the file…',
  fileFailed: '❌ Could not send the file.',
  donateThanks: (username, amount) =>
    `🎉 *Thank you so much, ${username}!*\n\n` +
    `Your donation of *${amount} Stars* has been received. ❤️`,

  start:
    '👋 Hi! I automatically fix social media links so they show a preview right in Telegram.\n\n' +
    `Supported: ${SUPPORTED_LIST}\n\n` +
    'Add me to a group chat and I will fix links automatically.',
  addToChat: '➕ Add to chat',
  addToOwnChat: '➕ Add to your chat',
  help: botMention =>
    '🔧 How to use:\n\n' +
    '1. Add the bot to a group chat\n' +
    '2. Give it admin rights to manage messages (delete and edit)\n' +
    '3. When someone sends a link, the bot posts a fixed version\n' +
    '4. Fixed links show a proper preview\n' +
    `5. You can also use me in private messages or inline: type ${botMention} in any chat followed by a link\n` +
    '6. Supported links:\n' +
    '   • Instagram (posts, reels, IGTV)\n' +
    '   • X.com / Twitter\n' +
    '   • TikTok\n' +
    '   • Reddit\n' +
    '   • Bluesky\n' +
    '   • DeviantArt\n' +
    '   • Pixiv\n\n' +
    'Commands:\n' +
    '/settings — chat settings (admins)\n' +
    '/chatstats — chat statistics (admins)\n' +
    '/premium — unlimited downloads\n' +
    '/purchases — my purchases\n' +
    '/paysupport — payment help\n' +
    '/terms — terms of use\n\n' +
    '🛟 Something broken? Write /feedback <message> and I will pass it to the developer.\n' +
    '❤️ Support the project: /donate',
  onboarding: botMention =>
    '👋 Hi! I automatically fix social media links so they show a preview right in the chat.\n\n' +
    `Supported: ${SUPPORTED_LIST}\n\n` +
    '⚙️ To remove the original message with the broken link I need the admin right “Delete messages”\n' +
    '🛠 Chat settings: /settings\n\n' +
    `Use me inline: ${botMention} <link>`,
  premiumDeliveryFailed: '❌ Could not send the file. Try later or /feedback.',
  passUpsell:
    'Download often? Get the unlimited pass and stop paying per video.',
  passUpsellButton: stars => `♾️ Unlimited forever — ⭐${stars}`,
  premiumActive:
    '♾️ Your unlimited download pass is active — save any video for free.',
  premiumOffer: stars =>
    `♾️ *Unlimited downloads*\n\n` +
    `One-time purchase — save any video forever without paying for each one.\n` +
    `Works in any chat with the bot and in private.\n\n` +
    `Price: ${stars} ⭐`,
  premiumBuy: stars => `Buy for ⭐${stars}`,
  inviteLink: url => `🔗 Your referral link:\n${url}\n\n`,
  inviteNoLink: '🔗 Could not determine the bot link. Try again later.\n\n',
  inviteCount: count =>
    `You invited: ${count} ${enPlural(count, 'user', 'users')}`,
  inviteReward: (count, threshold) =>
    `\n\n🎁 Invite ${threshold} new users and get the unlimited download pass forever. Progress: ${Math.min(count, threshold)}/${threshold}`,
  inviteRewardGranted: '\n\n🎁 Your unlimited pass for invites is active ♾️',
  referralJoined: (count, threshold) =>
    `🎉 A new user joined with your link! ${Math.min(count, threshold)}/${threshold} towards the unlimited pass.`,
  referralPassGranted: threshold =>
    `♾️ You invited ${threshold} users — the unlimited download pass is now yours forever. Thank you!`,
  donateGroupOnly: botMention =>
    `❤️ /donate works in a private chat. Message ${botMention} directly.`,
  donateText:
    '❤️ *Support the project*\n\n' +
    'You can support the bot with *Telegram Stars* or directly:\n\n' +
    '💳 Tinkoff: `https://www.tinkoff.ru/rm/r_niFZCEvUVm.PQsrZmuYJc/pTW9A14929`\n' +
    '💳 BOG: `GE76BG0000000538914758`\n' +
    'USDT TRC20: `TYS2zFqnBjRtwTUyJjggFtQk9zrJX6T976`\n' +
    '₿ BTC: `bc1q3ezgkak8swygvgfcqgtcxyswfmt4dzeeu93vq5`\n\n' +
    'Pick an amount in Stars below or use the details above 🙏',

  settingsGroupOnly: '⚙️ /settings works only in group chats.',
  settingsAdminsOnly: '⚙️ Settings are available to chat admins only.',
  settingsAdminsOnlyAlert: '⛔ Only admins can change settings.',
  settingsTitle:
    '⚙️ Chat settings\n\n' +
    '🔇 Quiet mode — no “Saved … a click” line\n' +
    '📌 Keep original — reply with the link instead of replacing the message\n' +
    '🖼 Albums — send Instagram carousels as an album\n' +
    '🗑 Delete button — under the bot’s messages\n' +
    '🌐 Platforms — which links to fix',
  settingsPlatformsTitle:
    '🌐 Platforms\n\nTap to turn link fixing on or off.',
  settingQuiet: '🔇 Quiet mode',
  settingKeepOriginal: '📌 Keep original',
  settingAlbums: '🖼 Instagram albums',
  settingDeleteButton: '🗑 Delete button',
  settingPlatforms: '🌐 Platforms',
  settingLanguage: '🗣 Language',
  settingsBack: '« Back',
  on: 'on',
  off: 'off',
  saved: '✅ Saved',
  saveFailed: '⚠️ Could not save the setting.',

  chatstatsGroupOnly: '📊 /chatstats works only in group chats.',
  chatstatsAdminsOnly: '📊 Statistics are available to chat admins only.',
  dbUnavailable: '📊 The database is unavailable.',
  chatstatsFailed: '📊 Could not load chat statistics. Try again later.',
  chatstatsEmpty: '📊 No links were fixed in the last 7 days.',
  chatstatsTitle: '📊 Chat statistics for 7 days',
  chatstatsTotal: n => `Links fixed: ${n}`,
  chatstatsTop: '🏆 Most active:',
  chatstatsUserLine: (i, name, cnt) =>
    `${i}. ${name} — ${cnt} ${enPlural(cnt, 'link', 'links')}`,
  platformOther: '🔗 Other',

  feedbackNotConfigured:
    '⚠️ The feedback channel is not configured. Try again later.',
  feedbackUsage:
    'ℹ️ Usage: /feedback <your message>\n' +
    'You can attach a screenshot: send a photo with the caption /feedback <description>.',
  feedbackThanks: '✅ Thanks! Your message was sent to the developer.',
  feedbackFailed: '⚠️ Could not send the feedback. Try again later.',

  paysupport:
    '💬 Payment help\n\n' +
    'Payments go through Telegram Stars. If a file did not arrive or a purchase did not activate, the Stars are refunded automatically.\n\n' +
    'If something went wrong, write it here in one message:\n' +
    '/paysupport <what happened>\n\n' +
    'I will pass it to the developer together with your recent payments. Purchase list: /purchases',
  paysupportSent:
    '✅ Your request was passed to the developer. The reply will come to this chat or in a private message.',
  terms:
    '📄 Terms of use\n\n' +
    '1. The bot replaces social media links with links to third-party preview services. Those services and the social networks themselves are outside the bot’s control and are not guaranteed to work.\n' +
    '2. Paid features are bought with Telegram Stars: a one-off save of a photo or video, and the “Unlimited” pass — a one-time purchase with no expiry.\n' +
    '3. If a paid file is not delivered or a purchase is not activated, the Stars are refunded. For other payment questions use /paysupport.\n' +
    '4. Donations are voluntary and non-refundable.\n' +
    '5. You are responsible for how you use downloaded material and for respecting copyright and the social networks’ rules.\n' +
    '6. The bot stores your Telegram ID, username, payment history and anonymous statistics of fixed links. Message texts are not stored.\n' +
    '7. The service is provided “as is”; these terms may be updated.',
  purchasesTitle: '🧾 Recent purchases',
  purchasesEmpty: '🧾 No purchases yet.',
  purchasesUnavailable: '🧾 Purchase history is unavailable right now.',
  purchaseKind: kind =>
    (
      ({
        donate: 'Donation',
        download: 'File save',
        personal_pro: 'Unlimited pass',
      }) as Record<string, string>
    )[kind] ?? kind,
  purchaseStatus: status =>
    (
      ({
        paid: 'paid',
        refunded: 'refunded',
        refund_failed: 'refund pending',
      }) as Record<string, string>
    )[status] ?? status,
};

const DICTIONARIES: Record<Lang, Strings> = { ru, en };

export function strings(lang: Lang): Strings {
  return DICTIONARIES[lang];
}

export const LANG_LABELS: Record<Lang, string> = {
  ru: 'Русский',
  en: 'English',
};
