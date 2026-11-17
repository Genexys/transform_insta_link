import http from 'http';
import { DATABASE_URL, PORT } from './app_env';
import { dbClient } from './db';
import { getDependencyHealth } from './health';
import { legacyRedditRedirect } from './link_utils';
import { previewMonitor } from './preview_probes';
import { log } from './runtime';
import { youtubeWorkerRelay } from './youtube_worker_relay';

async function getHealthStats() {
  if (!DATABASE_URL) return null;

  try {
    const result = await dbClient.query(`
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
  } catch {
    return null;
  }
}

// /health fans out to every fixer domain. Cache the result briefly so repeated
// hits (uptime monitors, curious visitors) don't each trigger a burst of
// outbound requests.
const HEALTH_CACHE_TTL_MS = 30_000;
let healthCache: {
  expires: number;
  value: Promise<Awaited<ReturnType<typeof getDependencyHealth>>>;
} | null = null;

function getCachedDependencyHealth() {
  const now = Date.now();
  if (!healthCache || healthCache.expires <= now) {
    healthCache = {
      expires: now + HEALTH_CACHE_TTL_MS,
      value: getDependencyHealth(),
    };
  }
  return healthCache.value;
}

export function startHttpServer() {
  const server = http.createServer(async (req, res) => {
    const urlPath = req.url || '';

    if (await youtubeWorkerRelay.handle(req, res)) return;

    // Reddit links the bot posted before it moved to vxreddit.
    if (urlPath.startsWith('/r/') || urlPath.startsWith('/comments/')) {
      res.writeHead(301, { Location: legacyRedditRedirect(urlPath) });
      res.end();
      return;
    }

    // Liveness only: "is this process serving HTTP". The platform healthcheck
    // points here so a third-party fixer outage can't fail a deploy of a
    // perfectly healthy bot. Dependency state lives on /health.
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
      res.end(
        JSON.stringify(
          {
            status: dependencyHealth.status,
            instagram: dependencyHealth.instagram,
            tiktok: dependencyHealth.tiktok,
            twitter: dependencyHealth.twitter,
            other: dependencyHealth.other,
            checks: dependencyHealth.checks,
            // Informational: does not change `status`. The bot works without
            // the worker; Shorts then download through the local yt-dlp.
            youtube_worker: youtubeWorkerRelay.status(),
            // Informational: the last hourly run of preview_probes.ts.
            previews: previewMonitor.status(),
            ...(stats && { stats }),
          },
          null,
          2
        )
      );
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('🤖 Fix Bot is running!');
  });

  server.listen(PORT, () => {
    log.info('HTTP server listening', { port: PORT });
  });

  return server;
}
