import pg from 'pg';
import { z } from 'zod';

export function createPool(env, { schema = 'public' } = {}) {
  const safeSchema = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/).parse(schema);
  const url = env.DATABASE_URL ? new URL(env.DATABASE_URL):null;
  // Keep certificate verification controlled here, not overridden by URL flags.
  for (const key of ['sslmode','sslcert','sslkey','sslrootcert']) url?.searchParams.delete(key);
  return new pg.Pool({
    ...(url ? { connectionString:url.toString() }:{}),
    options: `-c search_path=${safeSchema}`,
    host: env.POSTGRES_HOST,
    port: env.POSTGRES_PORT,
    database: env.POSTGRES_DB,
    user: env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD,
    ssl:env.POSTGRES_SSL ? { rejectUnauthorized:true }:false,
    max: 5,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 2500,
    query_timeout: 3000,
    statement_timeout: 3000,
  });
}
