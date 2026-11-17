"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.previewMonitor = exports.PREVIEW_SAMPLES = void 0;
exports.previewChecks = previewChecks;
exports.previewMetaTags = previewMetaTags;
exports.previewMediaUrl = previewMediaUrl;
exports.probePreview = probePreview;
exports.createPreviewMonitor = createPreviewMonitor;
const link_utils_1 = require("./link_utils");
const runtime_1 = require("./runtime");
exports.PREVIEW_SAMPLES = [
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
    {
        platform: 'Reddit',
        url: 'https://www.reddit.com/r/nextfuckinglevel/comments/1gh9elr/',
        expect: 'video',
    },
];
function previewChecks(samples = exports.PREVIEW_SAMPLES) {
    return samples.flatMap(sample => {
        const converted = sample.platform === 'TikTok'
            ? link_utils_1.TIKTOK_FIXERS.map(f => sample.url.replace(link_utils_1.tiktokRegex, f))
            : sample.platform === 'Twitter'
                ? link_utils_1.TWITTER_FIXERS.map(f => sample.url.replace(link_utils_1.twitterRegex, f))
                : [(0, link_utils_1.convertToInstaFix)(sample.url)];
        return converted.map(url => ({
            ...sample,
            converted: url,
            fixer: new URL(url).hostname,
        }));
    });
}
const TELEGRAM_UA = 'TelegramBot (like TwitterBot)';
const PAGE_TIMEOUT_MS = 20_000;
const MEDIA_TIMEOUT_MS = 45_000;
function previewMetaTags(html) {
    const tags = {};
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
function previewMediaUrl(tags, expect) {
    if (expect === 'image') {
        return tags['og:image'] ?? tags['og:image:url'] ?? tags['twitter:image'];
    }
    return (tags['og:video'] ??
        tags['og:video:url'] ??
        tags['og:video:secure_url'] ??
        tags['twitter:player:stream']);
}
function failure(err, what, timeoutMs) {
    const name = err?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
        return `${what} не ответила за ${timeoutMs / 1000} с`;
    }
    return `${what}: ${String(err?.message ?? err).slice(0, 100)}`;
}
async function probePreview(check, fetchImpl = fetch) {
    const startedAt = Date.now();
    let page;
    let html;
    try {
        page = await fetchImpl(check.converted, {
            headers: { 'User-Agent': TELEGRAM_UA },
            redirect: 'follow',
            signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
        });
        html = await page.text();
    }
    catch (err) {
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
        await res.body?.cancel().catch(() => { });
        if (!res.ok) {
            return { ok: false, reason: `${check.expect} ответило ${res.status}` };
        }
        const type = (res.headers.get('content-type') ?? '').toLowerCase();
        if (!type.startsWith(`${check.expect}/`) &&
            !type.startsWith('application/octet-stream')) {
            return {
                ok: false,
                reason: `вместо ${check.expect} пришло ${type || 'без типа'}`,
            };
        }
    }
    catch (err) {
        return { ok: false, reason: failure(err, check.expect, MEDIA_TIMEOUT_MS) };
    }
    return { ok: true, ms: Date.now() - startedAt };
}
function checkLabel(check) {
    const kind = check.expect === 'video' ? 'видео' : 'картинка';
    return `${check.platform} · ${check.fixer} · ${kind}`;
}
function createPreviewMonitor({ checks = previewChecks(), probe = probePreview, failAfter = 2, } = {}) {
    const states = checks.map(check => ({
        check,
        failures: 0,
        alerted: false,
    }));
    let checkedAt = null;
    let running = false;
    async function runOnce() {
        if (running)
            return null;
        running = true;
        try {
            const outcomes = await Promise.all(states.map(state => probe(state.check).catch((err) => ({
                ok: false,
                reason: String(err),
            }))));
            checkedAt = new Date();
            const broken = [];
            const fixed = [];
            outcomes.forEach((outcome, i) => {
                const state = states[i];
                state.last = outcome;
                if (outcome.ok) {
                    if (state.alerted)
                        fixed.push(`• ${checkLabel(state.check)}`);
                    state.failures = 0;
                    state.alerted = false;
                    return;
                }
                state.failures++;
                runtime_1.log.warn('Preview probe failed', {
                    platform: state.check.platform,
                    fixer: state.check.fixer,
                    expect: state.check.expect,
                    reason: outcome.reason,
                    failures: state.failures,
                });
                if (state.failures >= failAfter && !state.alerted) {
                    state.alerted = true;
                    broken.push(`• ${checkLabel(state.check)}: ${outcome.reason}\n  ${state.check.converted}`);
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
        }
        finally {
            running = false;
        }
    }
    function status() {
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
    function statusLines() {
        if (!checkedAt)
            return [];
        return states.map(({ check, last }) => last?.ok
            ? `✅ ${checkLabel(check)}`
            : `❌ ${checkLabel(check)}${last ? `: ${last.reason}` : ''}`);
    }
    function start(alert) {
        const run = () => {
            runOnce()
                .then(message => (message ? alert(message) : undefined))
                .catch(err => runtime_1.log.error('Preview probes failed', { err: String(err) }));
        };
        setTimeout(run, 3 * 60 * 1000);
        setInterval(run, 60 * 60 * 1000);
    }
    return { runOnce, status, statusLines, start };
}
exports.previewMonitor = createPreviewMonitor();
