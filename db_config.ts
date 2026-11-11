// Pure DB connection-config helpers. Kept free of runtime imports (dotenv,
// Sentry, pg) so scripts/run-migrations.js can reuse the compiled module.

export type DbSslConfig = false | { rejectUnauthorized: boolean };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function hostOf(connectionString: string): string | null {
  try {
    return new URL(connectionString).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// Decides whether to speak TLS to Postgres.
//
// DATABASE_SSL overrides everything:
//   disable → no TLS
//   require → TLS without certificate verification (managed Postgres with a
//             self-signed chain, e.g. Railway)
//   verify  → TLS with certificate verification
//
// Unset: a localhost database (the compose.yaml one has no TLS and rejects the
// handshake) gets no TLS; anything else keeps the historical production
// behaviour of TLS without verification.
export function resolveDbSsl(
  connectionString: string | undefined,
  mode: string | undefined = process.env.DATABASE_SSL
): DbSslConfig {
  const normalized = mode?.trim().toLowerCase();

  if (normalized === 'disable' || normalized === 'false' || normalized === 'off') {
    return false;
  }
  if (normalized === 'verify' || normalized === 'verify-full') {
    return { rejectUnauthorized: true };
  }
  if (normalized === 'require' || normalized === 'true' || normalized === 'on') {
    return { rejectUnauthorized: false };
  }

  const host = connectionString ? hostOf(connectionString) : null;
  if (host && LOCAL_HOSTS.has(host)) {
    return false;
  }
  return { rejectUnauthorized: false };
}
