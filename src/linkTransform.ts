import {
  DD_INSTAGRAM_HOST_PATTERN,
  INSTA_FIX_DOMAIN,
  INSTA_FIX_FALLBACK,
  INSTAGRAM_HOST_PATTERN,
  SHARE_HOSTS,
  TRAILING_PUNCTUATION_REGEX,
  URL_REGEX,
  VX_INSTAGRAM_HOST_PATTERN,
} from './config';

export function normalizeInstagramUrl(urlString: string): URL | null {
  try {
    const url = new URL(urlString);
    const host = url.hostname.toLowerCase();

    if (INSTAGRAM_HOST_PATTERN.test(host)) return url;

    if (DD_INSTAGRAM_HOST_PATTERN.test(host)) {
      url.hostname = host.replace(DD_INSTAGRAM_HOST_PATTERN, (_, prefix) => `${prefix}${'instagram.com'}`);
      return url;
    }

    if (VX_INSTAGRAM_HOST_PATTERN.test(host)) {
      url.hostname = host.replace(VX_INSTAGRAM_HOST_PATTERN, (_, prefix) => `${prefix}${'instagram.com'}`);
      return url;
    }

    if (host === INSTA_FIX_DOMAIN || host.endsWith(`.${INSTA_FIX_DOMAIN}`)) {
      url.hostname = host.replace(new RegExp(`${INSTA_FIX_DOMAIN.replace('.', '\\.')}$`, 'i'), 'instagram.com');
      return url;
    }

    if (host === INSTA_FIX_FALLBACK || host.endsWith(`.${INSTA_FIX_FALLBACK}`)) {
      url.hostname = host.replace(new RegExp(`${INSTA_FIX_FALLBACK.replace('.', '\\.')}$`, 'i'), 'instagram.com');
      return url;
    }

    return null;
  } catch {
    return null;
  }
}

export function normalizeShareUrl(urlString: string): URL | null {
  try {
    const url = new URL(urlString);
    const host = url.hostname.toLowerCase();
    return SHARE_HOSTS.has(host) ? url : null;
  } catch {
    return null;
  }
}

export function trimTrailingPunctuation(url: string): { cleanedUrl: string; trailingPunctuation: string } {
  const match = url.match(TRAILING_PUNCTUATION_REGEX);
  if (!match) return { cleanedUrl: url, trailingPunctuation: '' };

  return {
    cleanedUrl: url.slice(0, -match[0].length),
    trailingPunctuation: match[0],
  };
}

export function rewriteInstagramLink(urlString: string): string | null {
  const normalizedUrl = normalizeInstagramUrl(urlString);
  if (!normalizedUrl) return null;

  const originalHost = normalizedUrl.hostname;
  normalizedUrl.hostname = normalizedUrl.hostname.replace(INSTAGRAM_HOST_PATTERN, (_, prefix) => `${prefix}${INSTA_FIX_DOMAIN}`);

  if (normalizedUrl.hostname === originalHost) return null;
  return normalizedUrl.toString();
}

export function rewriteShareLink(urlString: string): string | null {
  const normalizedUrl = normalizeShareUrl(urlString);
  if (!normalizedUrl) return null;

  normalizedUrl.hostname = 'www.icloud.com';
  normalizedUrl.pathname = `/shortcuts/${normalizedUrl.pathname.replace(/^\/+/, '')}`;

  return normalizedUrl.toString();
}

export function extractUrls(text: string): string[] {
  const matches = text.match(URL_REGEX);
  return matches ? [...matches] : [];
}

export function replaceTransformedLinkInText(text: string): string | null {
  let replaced = false;

  const updatedText = text.replace(URL_REGEX, (match) => {
    const { cleanedUrl, trailingPunctuation } = trimTrailingPunctuation(match);
    const transformedUrl = rewriteInstagramLink(cleanedUrl) || rewriteShareLink(cleanedUrl);

    if (!transformedUrl) return match;

    replaced = true;
    return `${transformedUrl}${trailingPunctuation}`;
  });

  return replaced ? updatedText : null;
}

export function isInstagramLinkCandidate(text: string): boolean {
  const urls = extractUrls(text);

  return urls.some((url) => {
    const { cleanedUrl } = trimTrailingPunctuation(url);
    return Boolean(normalizeInstagramUrl(cleanedUrl) || normalizeShareUrl(cleanedUrl));
  });
}
