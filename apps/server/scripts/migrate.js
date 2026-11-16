import { env } from '../src/config/env.js';
import { createPool } from '../src/infrastructure/database.js';
import { runMigrations } from '../src/infrastructure/migrations.js';

const pool = createPool(env);
try {
  const migrations = await runMigrations(pool);
  console.log(migrations.length ? `Applied ${migrations.length} migration(s).` : 'Database is up to date.');
} catch (error) {
  console.error(`Migration failed (${error.code ?? error.name}). Check PostgreSQL and migration configuration.`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
