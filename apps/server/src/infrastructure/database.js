import pg from 'pg';
import { z } from 'zod';

export function createPool(env, { schema = 'public', databaseUrl = env.DATABASE_URL } = {}) {
  const safeSchema = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/).parse(schema);
  const url = databaseUrl ? new URL(databaseUrl):null;
  // Keep certificate verification controlled here, not overridden by URL flags.
  for (const key of ['sslmode','sslcert','sslkey','sslrootcert']) url?.searchParams.delete(key);
  return new pg.Pool({
    ...(url ? { connectionString:url.toString() } : {
      host: env.POSTGRES_HOST,
      port: env.POSTGRES_PORT,
      database: env.POSTGRES_DB,
      user: env.POSTGRES_USER,
      password: env.POSTGRES_PASSWORD,
    }),
    // Neon PgBouncer transaction pooling does not accept arbitrary startup
    // options. The deployed app uses PostgreSQL's default public schema.
    ...(safeSchema === 'public' ? {} : { options: `-c search_path=${safeSchema}` }),
    ssl:env.POSTGRES_SSL ? { rejectUnauthorized:true }:false,
    max: 5,
    idleTimeoutMillis: 10000,
    // Neon may need a few seconds to resume its scale-to-zero compute.
    connectionTimeoutMillis: 10000,
    query_timeout: 3000,
    statement_timeout: 3000,
  });
}
