import {
  INSTA_FIX_DOMAIN,
  INSTA_FIX_FALLBACK,
  TIKTOK_FIXERS,
  TWITTER_FIXERS,
} from './link_utils';

export async function checkService(url: string): Promise<'ok' | 'down'> {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(3000),
    });
    return res.status < 500 ? 'ok' : 'down';
  } catch {
    return 'down';
  }
}

export async function getDependencyHealth() {
  const [instaMain, instaFallback, ...rest] = await Promise.all([
    checkService(`https://${INSTA_FIX_DOMAIN}/`),
    checkService(`https://${INSTA_FIX_FALLBACK}/`),
    ...TIKTOK_FIXERS.map(f => checkService(`https://${f}/`)),
    ...TWITTER_FIXERS.map(f => checkService(`https://${f}/`)),
    checkService('https://bskx.app/'),
    checkService('https://fixdeviantart.com/'),
    checkService('https://phixiv.net/'),
  ]);

  const tiktokCount = TIKTOK_FIXERS.length;
  const twitterCount = TWITTER_FIXERS.length;
  const tiktokResults = rest.slice(0, tiktokCount);
  const twitterResults = rest.slice(tiktokCount, tiktokCount + twitterCount);
  const [bluesky, deviantart, pixiv] = rest.slice(tiktokCount + twitterCount);

  const instagram = {
    [INSTA_FIX_DOMAIN]: instaMain,
    [INSTA_FIX_FALLBACK]: instaFallback,
  };
  const tiktok = Object.fromEntries(
    TIKTOK_FIXERS.map((fixer, index) => [fixer, tiktokResults[index]])
  ) as Record<string, 'ok' | 'down'>;
  const twitter = Object.fromEntries(
    TWITTER_FIXERS.map((fixer, index) => [fixer, twitterResults[index]])
  ) as Record<string, 'ok' | 'down'>;
  const other = {
    'bskx.app': bluesky,
    'fixdeviantart.com': deviantart,
    'phixiv.net': pixiv,
  };

  const instagramOk = Object.values(instagram).some(state => state === 'ok');
  const tiktokOk = Object.values(tiktok).some(state => state === 'ok');
  const twitterOk = Object.values(twitter).some(state => state === 'ok');
  const blueskyOk = other['bskx.app'] === 'ok';
  const deviantartOk = other['fixdeviantart.com'] === 'ok';
  const pixivOk = other['phixiv.net'] === 'ok';
  const criticalOk = instagramOk && tiktokOk && twitterOk;
  const fullyOk = criticalOk && blueskyOk && deviantartOk && pixivOk;

  return {
    status: fullyOk ? 'ok' : criticalOk ? 'degraded' : 'down',
    instagram,
    tiktok,
    twitter,
    other,
    checks: {
      critical: {
        instagram: instagramOk,
        tiktok: tiktokOk,
        twitter: twitterOk,
      },
      supplemental: {
        bluesky: blueskyOk,
        deviantart: deviantartOk,
        pixiv: pixivOk,
      },
    },
  };
}
