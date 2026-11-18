import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { HealthResponseSchema } from '@fieldsync/contracts';
import { EnvironmentSchema } from '../apps/server/src/config/schema.js';
import { createLogger } from '../apps/server/src/infrastructure/logger.js';
import { createApp } from '../apps/server/src/app.js';
import { measureDependency } from '../apps/server/src/modules/health/service.js';

function health(status = 'ok') {
  return {
    status,
    service: 'fieldsync-api',
    timestamp: new Date().toISOString(),
    uptimeSeconds: 1,
    dependencies: {
      postgres: { status: status === 'ok' ? 'up' : 'down', latencyMs: 2 },
      redis: { status: 'up', latencyMs: 1 },
    },
  };
}

const minimumEnv = {
  POSTGRES_PASSWORD: 'test-password',
  REDIS_PASSWORD: 'test-password',
  MINIO_ROOT_USER: 'test-user',
  MINIO_ROOT_PASSWORD: 'test-password',
  S3_ACCESS_KEY_ID: 'test-user',
  S3_SECRET_ACCESS_KEY: 'test-password',
};

test('environment parses false as false and validates numeric ports', () => {
  const env = EnvironmentSchema.parse({ ...minimumEnv, AI_ENABLED: 'false', API_PORT: '3000' });
  assert.equal(env.AI_ENABLED, false);
  assert.equal(env.API_PORT, 3000);
  assert.equal(env.S3_FORCE_PATH_STYLE, true);
  assert.equal(env.RUN_INLINE_WORKER, false);
  assert.equal(EnvironmentSchema.parse({ ...minimumEnv, RUN_INLINE_WORKER: 'true' }).RUN_INLINE_WORKER, true);
  assert.equal(EnvironmentSchema.safeParse({ ...minimumEnv, API_PORT: '0' }).success, false);
  assert.equal(EnvironmentSchema.safeParse({ ...minimumEnv, AI_ENABLED: 'yes' }).success, false);
  assert.equal(EnvironmentSchema.safeParse({ ...minimumEnv, DATABASE_URL:'postgresql://user:pass@ep-demo-pooler.region.aws.neon.tech/db' }).success, false);
  assert.equal(EnvironmentSchema.safeParse({ ...minimumEnv, DATABASE_URL:'postgresql://user:pass@ep-demo-pooler.region.aws.neon.tech/db', MIGRATIONS_DATABASE_URL:'postgresql://user:pass@ep-demo.region.aws.neon.tech/db' }).success, true);
  assert.equal(EnvironmentSchema.safeParse({ ...minimumEnv, DATABASE_URL:'postgresql://user:pass@ep-demo-pooler.region.aws.neon.tech/db', DATABASE_URL_UNPOOLED:'postgresql://user:pass@ep-demo.region.aws.neon.tech/db' }).success, true);
  assert.equal(EnvironmentSchema.safeParse({ ...minimumEnv, MIGRATIONS_DATABASE_URL:'postgresql://user:pass@ep-demo-pooler.region.aws.neon.tech/db' }).success, false);
  assert.equal(EnvironmentSchema.safeParse({ ...minimumEnv, RUN_INLINE_WORKER: 'yes' }).success, false);
});

test('environment rejects invalid URLs without throwing outside Zod', () => {
  assert.equal(EnvironmentSchema.safeParse({ ...minimumEnv, S3_ENDPOINT: 'not-a-url' }).success, false);
});

test('health contract cannot claim success with a failed dependency', () => {
  const inconsistent = health();
  inconsistent.dependencies.redis.status = 'down';
  assert.equal(HealthResponseSchema.safeParse(inconsistent).success, false);
});

test('health API returns validated 200 response and prevents caching', async () => {
  const app = createApp({ getHealth: async () => health(), logger: createLogger('silent') });
  const response = await request(app).get('/api/v1/health').expect(200);
  HealthResponseSchema.parse(response.body);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.match(response.headers['x-request-id'], /^[0-9a-f-]{36}$/);
});

test('health API reports dependency failure with HTTP 503', async () => {
  const app = createApp({ getHealth: async () => health('degraded'), logger: createLogger('silent') });
  const response = await request(app).get('/api/v1/health').expect(503);
  assert.equal(response.body.dependencies.postgres.status, 'down');
});

test('health query rejects unknown input', async () => {
  let called = false;
  const app = createApp({ getHealth: async () => { called = true; return health(); }, logger: createLogger('silent') });
  const response = await request(app).get('/api/v1/health?organizationId=untrusted').expect(400);
  assert.equal(response.body.error.code, 'INVALID_REQUEST');
  assert.equal(called, false);
});

test('malformed internal health output cannot be sent as a healthy response', async () => {
  const app = createApp({ getHealth: async () => ({ status: 'ok' }), logger: createLogger('silent') });
  await request(app).get('/api/v1/health').expect(500);
});

test('unexpected errors do not leak connection details', async () => {
  const app = createApp({ getHealth: async () => { throw new Error('password=private'); }, logger: createLogger('silent') });
  const response = await request(app).get('/api/v1/health').expect(500);
  assert.equal(JSON.stringify(response.body).includes('private'), false);
});

test('dependency measurement preserves failed status without raw errors', async () => {
  const result = await measureDependency(async () => { throw new Error('secret'); });
  assert.equal(result.status, 'down');
  assert.equal(typeof result.latencyMs, 'number');
  assert.equal('message' in result, false);
});
