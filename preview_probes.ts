// Checks that converted links really give Telegram a preview. Each sample is a
// real, long-lived post. It goes through the same conversion as a user's link,
// the result is fetched the way Telegram's preview bot fetches it, and the
// og:image or og:video it names is downloaded (the first kilobyte). A fixer
// whose home page answers can still return pages without media; this catches
// that, and a conversion that produces a broken link.
//
// A sample failing twice in a row (two hourly runs) sends one admin alert, and
// one more when it works again. If a sample post is deleted, replace it here.
//
// Instagram is not sampled: the preview service and runInstaAuthMonitor watch
// it already, with alerts of their own.

import {
  TIKTOK_FIXERS,
  TWITTER_FIXERS,
  convertToInstaFix,
  tiktokRegex,
  twitterRegex,
} from './link_utils';
import { log } from './runtime';

export type PreviewSample = {
  platform: string;
  url: string;
  expect: 'image' | 'video';
};

export const PREVIEW_SAMPLES: PreviewSample[] = [
  // TikTok's own oEmbed example, up since 2019.
  {
    platform: 'TikTok',
    url: 'https://www.tiktok.com/@scout2015/video/6718335390845095173',
    expect: 'video',
  },
  {
    platform: 'Twitter',
    url: 'https://x.com/BarackObama/status/266031293945503744',
    expect: 'image',
  },
  // Videos go through fxtwitter's api.fxtwitter.com/2/go redirect to
  // video.twimg.com, which the image sample above does not exercise.
  {
    platform: 'Twitter',
    url: 'https://x.com/elonmusk/status/1585341984679469056',
    expect: 'video',
  },
  {
    platform: 'Bluesky',
    url: 'https://bsky.app/profile/bsky.app/post/3l4cilpvtr22w',
    expect: 'image',
  },
  {
    platform: 'Bluesky',
    url: 'https://bsky.app/profile/bsky.app/post/3l3wdzzedvv2y',
    expect: 'video',
  },
  {
    platform: 'DeviantArt',
    url: 'https://www.deviantart.com/loish/art/willows-913624674',
    expect: 'image',
  },
  {
    platform: 'Pixiv',
    url: 'https://www.pixiv.net/en/artworks/151053778',
    expect: 'image',
  },
  // One of the subreddit's top posts of all time.
  {
    platform: 'Reddit',
    url: 'https://www.reddit.com/r/nextfuckinglevel/comments/1gh9elr/',
    expect: 'video',
  },
];

export type PreviewCheck = PreviewSample & {
  // The converted link, and the host it points at.
  converted: string;
  fixer: string;
};

// Every fixer gets a check: TikTok and Twitter links go to whichever of their
// fixers answers, the rest through convertToInstaFix.
export function previewChecks(
  samples: PreviewSample[] = PREVIEW_SAMPLES
): PreviewCheck[] {
  return samples.flatMap(sample => {
    const converted =
      sample.platform === 'TikTok'
        ? TIKTOK_FIXERS.map(f => sample.url.replace(tiktokRegex, f))
        : sample.platform === 'Twitter'
          ? TWITTER_FIXERS.map(f => sample.url.replace(twitterRegex, f))
          : [convertToInstaFix(sample.url)];
    return converted.map(url => ({
      ...sample,
      converted: url,
      fixer: new URL(url).hostname,
    }));
  });
}

// Telegram's link preview fetcher.
const TELEGRAM_UA = 'TelegramBot (like TwitterBot)';
const PAGE_TIMEOUT_MS = 20_000;
// vxreddit renders the video on first request, which takes ~10 s.
const MEDIA_TIMEOUT_MS = 45_000;

// <meta property|name="…" content="…"> in any attribute order; the first of
// each key wins, as for Telegram.
export function previewMetaTags(html: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i
      .exec(tag)?.[1]
      ?.toLowerCase();
    const value = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (key && value !== undefined && !(key in tags)) {
      tags[key] = value.replace(/&amp;/g, '&');
    }
  }
  return tags;
}

export function previewMediaUrl(
  tags: Record<string, string>,
  expect: 'image' | 'video'
): string | undefined {
  if (expect === 'image') {
    return tags['og:image'] ?? tags['og:image:url'] ?? tags['twitter:image'];
  }
  return (
    tags['og:video'] ??
    tags['og:video:url'] ??
    tags['og:video:secure_url'] ??
    tags['twitter:player:stream']
  );
}

export type ProbeOutcome =
  { ok: true; ms: number } | { ok: false; reason: string };

type Fetch = typeof fetch;

function failure(err: unknown, what: string, timeoutMs: number): string {
  const name = (err as Error)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return `${what} не ответила за ${timeoutMs / 1000} с`;
  }
  return `${what}: ${String((err as Error)?.message ?? err).slice(0, 100)}`;
}

export async function probePreview(
  check: PreviewCheck,
  fetchImpl: Fetch = fetch
): Promise<ProbeOutcome> {
  const startedAt = Date.now();
  let page: Response;
  let html: string;
  try {
    page = await fetchImpl(check.converted, {
      headers: { 'User-Agent': TELEGRAM_UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
    html = await page.text();
  } catch (err) {
    return { ok: false, reason: failure(err, 'страница', PAGE_TIMEOUT_MS) };
  }
  if (!page.ok) {
    return { ok: false, reason: `страница ответила ${page.status}` };
  }
  const media = previewMediaUrl(previewMetaTags(html), check.expect);
  if (!media) {
    return {
      ok: false,
      reason: `на странице нет ${check.expect === 'video' ? 'og:video' : 'og:image'}`,
    };
  }

  try {
    const res = await fetchImpl(new URL(media, page.url || check.converted), {
      headers: { 'User-Agent': TELEGRAM_UA, Range: 'bytes=0-1023' },
      redirect: 'follow',
      signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => {});
    if (!res.ok) {
      return { ok: false, reason: `${check.expect} ответило ${res.status}` };
    }
    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    if (
      !type.startsWith(`${check.expect}/`) &&
      !type.startsWith('application/octet-stream')
    ) {
      return {
        ok: false,
        reason: `вместо ${check.expect} пришло ${type || 'без типа'}`,
      };
    }
  } catch (err) {
    return { ok: false, reason: failure(err, check.expect, MEDIA_TIMEOUT_MS) };
  }
  return { ok: true, ms: Date.now() - startedAt };
}

function checkLabel(check: PreviewCheck): string {
  const kind = check.expect === 'video' ? 'видео' : 'картинка';
  return `${check.platform} · ${check.fixer} · ${kind}`;
}

type CheckState = {
  check: PreviewCheck;
  failures: number;
  alerted: boolean;
  last?: ProbeOutcome;
};

export type PreviewStatus = {
  checked_at: string | null;
  results: {
    platform: string;
    fixer: string;
    expect: 'image' | 'video';
    ok: boolean | null;
    reason?: string;
    ms?: number;
  }[];
};

export function createPreviewMonitor({
  checks = previewChecks(),
  probe = probePreview,
  failAfter = 2,
}: {
  checks?: PreviewCheck[];
  probe?: (check: PreviewCheck) => Promise<ProbeOutcome>;
  failAfter?: number;
} = {}) {
  const states: CheckState[] = checks.map(check => ({
    check,
    failures: 0,
    alerted: false,
  }));
  let checkedAt: Date | null = null;
  let running = false;

  // Probes every sample once and returns the alert to send, if any.
  async function runOnce(): Promise<string | null> {
    if (running) return null;
    running = true;
    try {
      const outcomes = await Promise.all(
        states.map(state =>
          probe(state.check).catch((err): ProbeOutcome => ({
            ok: false,
            reason: String(err),
          }))
        )
      );
      checkedAt = new Date();
      const broken: string[] = [];
      const fixed: string[] = [];
      outcomes.forEach((outcome, i) => {
        const state = states[i];
        state.last = outcome;
        if (outcome.ok) {
          if (state.alerted) fixed.push(`• ${checkLabel(state.check)}`);
          state.failures = 0;
          state.alerted = false;
          return;
        }
        state.failures++;
        log.warn('Preview probe failed', {
          platform: state.check.platform,
          fixer: state.check.fixer,
          expect: state.check.expect,
          reason: outcome.reason,
          failures: state.failures,
        });
        if (state.failures >= failAfter && !state.alerted) {
          state.alerted = true;
          broken.push(
            `• ${checkLabel(state.check)}: ${outcome.reason}\n  ${state.check.converted}`
          );
        }
      });
      const parts = [
        ...(broken.length
          ? [
              `[ПРЕВЬЮ] Не работают на реальных постах:\n${broken.join('\n')}\n` +
                'Если пост удалён, замени образец в preview_probes.ts.',
            ]
          : []),
        ...(fixed.length
          ? [`[ПРЕВЬЮ] Снова работают ✅\n${fixed.join('\n')}`]
          : []),
      ];
      return parts.length ? parts.join('\n\n') : null;
    } finally {
      running = false;
    }
  }

  function status(): PreviewStatus {
    return {
      checked_at: checkedAt?.toISOString() ?? null,
      results: states.map(({ check, last }) => ({
        platform: check.platform,
        fixer: check.fixer,
        expect: check.expect,
        ok: last ? last.ok : null,
        ...(last && !last.ok ? { reason: last.reason } : {}),
        ...(last && last.ok ? { ms: last.ms } : {}),
      })),
    };
  }

  // Lines for the periodic service status message.
  function statusLines(): string[] {
    if (!checkedAt) return [];
    return states.map(({ check, last }) =>
      last?.ok
        ? `✅ ${checkLabel(check)}`
        : `❌ ${checkLabel(check)}${last ? `: ${last.reason}` : ''}`
    );
  }

  function start(alert: (message: string) => Promise<void>): void {
    const run = () => {
      runOnce()
        .then(message => (message ? alert(message) : undefined))
        .catch(err => log.error('Preview probes failed', { err: String(err) }));
    };
    setTimeout(run, 3 * 60 * 1000);
    setInterval(run, 60 * 60 * 1000);
  }

  return { runOnce, status, statusLines, start };
}

export const previewMonitor = createPreviewMonitor();
