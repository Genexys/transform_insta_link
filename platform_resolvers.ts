import { log } from './runtime';
import { logLinkEvent } from './db';
import {
  INSTA_FIX_DOMAIN,
  INSTA_FIX_FALLBACK,
  instaRegex,
  TIKTOK_FIXERS,
  tiktokRegex,
  TWITTER_FIXERS,
  twitterRegex,
} from './link_utils';

type SendAdminAlert = (message: string) => Promise<void>;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry(
  url: string,
  opts: RequestInit
): Promise<Response> {
  try {
    return await fetch(url, opts);
  } catch {
    await sleep(300);
    return await fetch(url, opts);
  }
}

export function createPlatformResolvers(sendAdminAlert: SendAdminAlert) {
  async function getWorkingInstaFixUrl(
    originalUrl: string,
    chatId?: number,
    userId?: number
  ): Promise<string> {
    const selfHostedUrl = originalUrl.replace(instaRegex, INSTA_FIX_DOMAIN);

    try {
      await fetchWithRetry(`https://${INSTA_FIX_DOMAIN}/health`, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      log.warn('Instagram self-hosted unreachable, using fallback', {
        url: originalUrl,
      });
      const fallbackUrl = originalUrl.replace(instaRegex, INSTA_FIX_FALLBACK);
      try {
        await fetchWithRetry(`https://${INSTA_FIX_FALLBACK}/`, {
          method: 'HEAD',
          redirect: 'manual',
          signal: AbortSignal.timeout(3000),
        });
        logLinkEvent('instagram', INSTA_FIX_FALLBACK, true, chatId, userId);
        return fallbackUrl;
      } catch {}
      log.error('Both Instagram services are unreachable', { url: originalUrl });
      logLinkEvent('instagram', 'none', true, chatId, userId);
      sendAdminAlert(
        `[INSTAGRAM] Оба сервиса недоступны\nURL: ${originalUrl}`
      ).catch(() => {});
      return fallbackUrl;
    }

    try {
      await fetch(`https://${selfHostedUrl}`, {
        method: 'GET',
        signal: AbortSignal.timeout(25000),
      });
    } catch {
      log.warn('Instagram extraction warmup failed or timed out', {
        url: originalUrl,
      });
    }
    logLinkEvent('instagram', INSTA_FIX_DOMAIN, false, chatId, userId);
    return selfHostedUrl;
  }

  async function getWorkingTikTokUrl(
    originalUrl: string,
    chatId?: number,
    userId?: number
  ): Promise<string> {
    const checks = TIKTOK_FIXERS.map(async fixer => {
      const fixedUrl = originalUrl.replace(tiktokRegex, fixer);
      const res = await fetchWithRetry(fixedUrl, {
        method: 'HEAD',
        redirect: 'manual',
        signal: AbortSignal.timeout(3000),
      });
      if (res.status !== 200) throw new Error(`${fixer}: ${res.status}`);
      return fixedUrl;
    });
    try {
      const result = await Promise.any(checks);
      const service =
        TIKTOK_FIXERS.find(f => result.includes(f)) ?? TIKTOK_FIXERS[0];
      logLinkEvent(
        'tiktok',
        service,
        service !== TIKTOK_FIXERS[0],
        chatId,
        userId
      );
      return result;
    } catch {
      log.warn('All TikTok fixers failed', { url: originalUrl });
      logLinkEvent('tiktok', 'none', true, chatId, userId);
      return originalUrl.replace(tiktokRegex, TIKTOK_FIXERS[0]);
    }
  }

  async function getWorkingTwitterUrl(
    originalUrl: string,
    chatId?: number,
    userId?: number
  ): Promise<string> {
    const checks = TWITTER_FIXERS.map(async fixer => {
      const fixedUrl = originalUrl.replace(twitterRegex, fixer);
      const res = await fetchWithRetry(fixedUrl, {
        method: 'HEAD',
        redirect: 'manual',
        signal: AbortSignal.timeout(3000),
      });
      if (res.status >= 500) throw new Error(`${fixer}: ${res.status}`);
      return fixedUrl;
    });
    try {
      const result = await Promise.any(checks);
      const service =
        TWITTER_FIXERS.find(f => result.includes(f)) ?? TWITTER_FIXERS[0];
      logLinkEvent(
        'twitter',
        service,
        service !== TWITTER_FIXERS[0],
        chatId,
        userId
      );
      return result;
    } catch {
      log.warn('All Twitter fixers failed', { url: originalUrl });
      logLinkEvent('twitter', 'none', true, chatId, userId);
      return originalUrl.replace(twitterRegex, TWITTER_FIXERS[0]);
    }
  }

  return {
    getWorkingInstaFixUrl,
    getWorkingTikTokUrl,
    getWorkingTwitterUrl,
  };
}
