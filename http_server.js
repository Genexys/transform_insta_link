"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startHttpServer = startHttpServer;
const http_1 = __importDefault(require("http"));
const app_env_1 = require("./app_env");
const db_1 = require("./db");
const health_1 = require("./health");
const link_utils_1 = require("./link_utils");
const runtime_1 = require("./runtime");
function escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
async function handleRedditEmbed(path, res) {
    const redditUrl = `https://www.reddit.com${path}`;
    const match = path.match(/^\/r\/([^/]+)\/comments\/([^/]+)/);
    if (!match) {
        res.writeHead(302, { Location: redditUrl });
        res.end();
        return;
    }
    const [, subreddit, postId] = match;
    try {
        const apiUrl = `https://www.reddit.com/r/${subreddit}/comments/${postId}/.json`;
        const apiRes = await fetch(apiUrl, {
            headers: { 'User-Agent': 'TelegramBot:transform_insta_link:v1.0' },
            signal: AbortSignal.timeout(5000),
        });
        if (!apiRes.ok)
            throw new Error(`Reddit API ${apiRes.status}`);
        const data = (await apiRes.json());
        const post = data[0]?.data?.children?.[0]?.data;
        if (!post)
            throw new Error('No post data');
        const title = post.title || 'Reddit post';
        const author = post.author || '';
        const subredditPrefixed = post.subreddit_name_prefixed || `r/${subreddit}`;
        const score = post.score ?? 0;
        const numComments = post.num_comments ?? 0;
        const selftext = (post.selftext || '').substring(0, 200);
        const description = selftext ||
            `by u/${author} in ${subredditPrefixed} · ${score} pts · ${numComments} comments`;
        let ogImage = '';
        if (post.preview?.images?.[0]?.source?.url) {
            ogImage = post.preview.images[0].source.url.replace(/&amp;/g, '&');
        }
        else if (post.thumbnail?.startsWith('http')) {
            ogImage = post.thumbnail;
        }
        let ogVideo = '';
        if (post.is_video && post.media?.reddit_video?.fallback_url) {
            ogVideo = post.media.reddit_video.fallback_url;
        }
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta property="og:site_name" content="Reddit">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${redditUrl}">
${ogImage ? `<meta property="og:image" content="${escapeHtml(ogImage)}">` : ''}
${ogVideo ? `<meta property="og:video" content="${escapeHtml(ogVideo)}"><meta property="og:video:type" content="video/mp4">` : ''}
<meta http-equiv="refresh" content="0; url=${redditUrl}">
</head><body>Redirecting to <a href="${redditUrl}">Reddit post</a></body></html>`;
        (0, db_1.logLinkEvent)('reddit', link_utils_1.REDDIT_EMBED_DOMAIN, false);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
    }
    catch (err) {
        runtime_1.log.error('Reddit embed failed', { path, err: String(err) });
        res.writeHead(302, { Location: redditUrl });
        res.end();
    }
}
async function getHealthStats() {
    if (!app_env_1.DATABASE_URL)
        return null;
    try {
        const result = await db_1.dbClient.query(`
      SELECT
        COUNT(*)::int as total,
        COUNT(*) FILTER (WHERE platform = 'instagram')::int as instagram,
        COUNT(*) FILTER (WHERE platform = 'tiktok')::int as tiktok,
        COUNT(*) FILTER (WHERE platform = 'other')::int as other,
        ROUND(100.0 * COUNT(*) FILTER (WHERE is_fallback) / NULLIF(COUNT(*), 0))::int as fallback_pct
      FROM link_events
      WHERE created_at > NOW() - INTERVAL '24 hours'
    `);
        const row = result.rows[0];
        return {
            last_24h: {
                total: row.total,
                instagram: row.instagram,
                tiktok: row.tiktok,
                other: row.other,
                fallback_rate: `${row.fallback_pct ?? 0}%`,
            },
        };
    }
    catch {
        return null;
    }
}
function startHttpServer() {
    const server = http_1.default.createServer(async (req, res) => {
        const urlPath = req.url || '';
        if (urlPath.startsWith('/r/')) {
            await handleRedditEmbed(urlPath, res);
            return;
        }
        if (urlPath === '/health') {
            const dependencyHealth = await (0, health_1.getDependencyHealth)();
            const stats = await getHealthStats();
            res.writeHead(dependencyHealth.status === 'down' ? 503 : 200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: dependencyHealth.status,
                instagram: dependencyHealth.instagram,
                tiktok: dependencyHealth.tiktok,
                twitter: dependencyHealth.twitter,
                other: dependencyHealth.other,
                checks: dependencyHealth.checks,
                ...(stats && { stats }),
            }, null, 2));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('🤖 Fix Bot is running!');
    });
    server.listen(app_env_1.PORT, () => {
        runtime_1.log.info('HTTP server listening', { port: app_env_1.PORT });
    });
    return server;
}
