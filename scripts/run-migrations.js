const path = require('path');
require('dotenv').config();

function getDirection() {
  const direction = process.argv[2] || 'up';
  if (direction !== 'up' && direction !== 'down') {
    throw new Error(`Unsupported migration direction: ${direction}`);
  }
  return direction;
}

async function main() {
  const direction = getDirection();
  const skipIfNoDb = process.argv.includes('--skip-if-no-db');
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    if (skipIfNoDb) {
      console.log('[migrate] DATABASE_URL missing, skipping migrations');
      return;
    }
    throw new Error('DATABASE_URL is required for db:migrate');
  }

  const { runner } = await import('node-pg-migrate');

  const count = direction === 'down' ? 1 : undefined;
  const migrations = await runner({
    databaseUrl: {
      connectionString: databaseUrl,
      ssl: {
        rejectUnauthorized: false,
      },
    },
    dir: path.join(process.cwd(), 'migrations'),
    direction,
    migrationsTable: 'pgmigrations',
    checkOrder: true,
    createSchema: false,
    createMigrationsSchema: false,
    singleTransaction: true,
    ...(count && { count }),
    log: message => console.log(`[migrate] ${message}`),
  });

  console.log(
    `[migrate] ${direction} completed (${migrations.length} migration(s))`
  );
}

main().catch(error => {
  console.error(
    '[migrate] failed:',
    error instanceof Error ? error.message : String(error)
  );
  process.exit(1);
});
