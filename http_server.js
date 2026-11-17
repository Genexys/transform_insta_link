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
const preview_probes_1 = require("./preview_probes");
const runtime_1 = require("./runtime");
const youtube_worker_relay_1 = require("./youtube_worker_relay");
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
const HEALTH_CACHE_TTL_MS = 30_000;
let healthCache = null;
function getCachedDependencyHealth() {
    const now = Date.now();
    if (!healthCache || healthCache.expires <= now) {
        healthCache = {
            expires: now + HEALTH_CACHE_TTL_MS,
            value: (0, health_1.getDependencyHealth)(),
        };
    }
    return healthCache.value;
}
function startHttpServer() {
    const server = http_1.default.createServer(async (req, res) => {
        const urlPath = req.url || '';
        if (await youtube_worker_relay_1.youtubeWorkerRelay.handle(req, res))
            return;
        if (urlPath.startsWith('/r/') || urlPath.startsWith('/comments/')) {
            res.writeHead(301, { Location: (0, link_utils_1.legacyRedditRedirect)(urlPath) });
            res.end();
            return;
        }
        if (urlPath === '/healthz') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
            return;
        }
        if (urlPath === '/health' || urlPath.startsWith('/health?')) {
            const dependencyHealth = await getCachedDependencyHealth();
            const stats = await getHealthStats();
            res.writeHead(dependencyHealth.status === 'down' ? 503 : 200, {
                'Content-Type': 'application/json',
            });
            res.end(JSON.stringify({
                status: dependencyHealth.status,
                instagram: dependencyHealth.instagram,
                tiktok: dependencyHealth.tiktok,
                twitter: dependencyHealth.twitter,
                other: dependencyHealth.other,
                checks: dependencyHealth.checks,
                youtube_worker: youtube_worker_relay_1.youtubeWorkerRelay.status(),
                previews: preview_probes_1.previewMonitor.status(),
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
