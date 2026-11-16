import { fileURLToPath } from 'node:url';
import migrate from 'node-pg-migrate';
import { z } from 'zod';

export async function runMigrations(pool, logger = console, schema = 'public') {
  const safeSchema = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/).parse(schema);
  const client = await pool.connect();
  try {
    return await migrate({
      dbClient: client,
      dir: fileURLToPath(new URL('../../migrations/', import.meta.url)),
      direction: 'up',
      migrationsTable: 'pgmigrations',
      schema: safeSchema,
      checkOrder: true,
      singleTransaction: true,
      logger,
    });
  } finally {
    client.release();
  }
}
