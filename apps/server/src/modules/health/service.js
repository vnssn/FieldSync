import { performance } from 'node:perf_hooks';
import Redis from 'ioredis';
import { z } from 'zod';
import { HealthResponseSchema } from '@fieldsync/contracts';

const probeResult = z.object({ rows: z.array(z.object({ ok: z.literal(1) })).length(1) });
const pong = z.literal('PONG');

export async function measureDependency(check, onError = () => {}) {
  const started = performance.now();
  try {
    await check();
    return { status: 'up', latencyMs: Math.round((performance.now() - started) * 10) / 10 };
  } catch (error) {
    onError(error);
    return { status: 'down', latencyMs: Math.round((performance.now() - started) * 10) / 10 };
  }
}

export function createHealthCheck({ pool, env, logger }) {
  return async function getHealth() {
    const [postgres, redis] = await Promise.all([
      measureDependency(async () => {
        const result = await pool.query('SELECT $1::int AS ok', [1]);
        probeResult.parse(result);
      }, () => logger?.warn({ dependency: 'postgres' }, 'Health check failed')),
      measureDependency(async () => {
        // A short-lived probe reconnects cleanly after Redis restarts.
        // Long-lived BullMQ connections belong in the future jobs module.
        const client = new Redis({
          host: env.REDIS_HOST,
          port: env.REDIS_PORT,
          password: env.REDIS_PASSWORD,
          lazyConnect: true,
          enableOfflineQueue: false,
          connectTimeout: 2500,
          commandTimeout: 2500,
          maxRetriesPerRequest: 0,
          retryStrategy: () => null,
        });
        client.on('error', () => {});
        try {
          await client.connect();
          pong.parse(await client.ping());
        } finally {
          client.disconnect();
        }
      }, () => logger?.warn({ dependency: 'redis' }, 'Health check failed')),
    ]);

    return HealthResponseSchema.parse({
      status: postgres.status === 'up' && redis.status === 'up' ? 'ok' : 'degraded',
      service: 'fieldsync-api',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      dependencies: { postgres, redis },
    });
  };
}
