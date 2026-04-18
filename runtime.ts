import dotenv from 'dotenv';
import * as Sentry from '@sentry/node';

dotenv.config();

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || 'production',
  tracesSampleRate: 0.2,
});

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (value) {
    return value;
  }

  console.error(
    JSON.stringify({
      level: 'fatal',
      msg: `Missing required env var: ${name}`,
      ts: new Date().toISOString(),
    })
  );
  process.exit(1);
}

export const log = {
  info: (msg: string, meta?: object) =>
    console.log(
      JSON.stringify({
        level: 'info',
        msg,
        ...meta,
        ts: new Date().toISOString(),
      })
    ),
  warn: (msg: string, meta?: object) =>
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg,
        ...meta,
        ts: new Date().toISOString(),
      })
    ),
  error: (msg: string, meta?: object) => {
    console.error(
      JSON.stringify({
        level: 'error',
        msg,
        ...meta,
        ts: new Date().toISOString(),
      })
    );
    Sentry.captureException(
      meta?.hasOwnProperty('err') ? (meta as any).err : new Error(msg),
      {
        extra: meta as Record<string, unknown>,
      }
    );
  },
};
