export type BillingKind = 'donate' | 'personal_pro' | 'chat_pro';

export const PERSONAL_PRO_PRICE_STARS = 100;
export const CHAT_PRO_PRICE_STARS = 250;
export const DONATE_AMOUNTS_STARS = [50, 100, 250, 500] as const;

export type ParsedBillingPayload = {
  kind: BillingKind;
  amount: number;
  chatId?: number;
  raw: string;
  isLegacy: boolean;
};

export function buildBillingPayload(
  kind: BillingKind,
  amount: number,
  options?: { chatId?: number }
): string {
  if (kind === 'chat_pro') {
    if (!options?.chatId) {
      throw new Error('chatId is required for chat_pro billing payloads');
    }

    return `billing:${kind}:${amount}:${options.chatId}`;
  }

  return `billing:${kind}:${amount}`;
}

export function parseBillingPayload(
  payload: string
): ParsedBillingPayload | null {
  const normalized = payload.trim();

  const modernMatch = normalized.match(
    /^billing:(donate|personal_pro|chat_pro):(\d+)(?::(-?\d+))?$/
  );
  if (modernMatch) {
    const [, kind, amountRaw, chatIdRaw] = modernMatch;
    const amount = parseInt(amountRaw, 10);
    const chatId = chatIdRaw ? parseInt(chatIdRaw, 10) : undefined;

    if (!Number.isFinite(amount) || amount <= 0) {
      return null;
    }

    if (kind === 'chat_pro' && !Number.isFinite(chatId)) {
      return null;
    }

    return {
      kind: kind as BillingKind,
      amount,
      chatId,
      raw: normalized,
      isLegacy: false,
    };
  }

  const legacyDonateMatch = normalized.match(/^stars_donate_(\d+)$/);
  if (legacyDonateMatch) {
    const amount = parseInt(legacyDonateMatch[1], 10);
    if (!Number.isFinite(amount) || amount <= 0) {
      return null;
    }

    return {
      kind: 'donate',
      amount,
      raw: normalized,
      isLegacy: true,
    };
  }

  return null;
}
