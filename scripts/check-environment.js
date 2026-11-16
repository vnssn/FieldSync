import { env } from '../apps/server/src/config/env.js';
import { createPool } from '../apps/server/src/infrastructure/database.js';
import { createHealthCheck, measureDependency } from '../apps/server/src/modules/health/service.js';
import { createStorageClient, verifyBucket } from '../apps/server/src/infrastructure/storage.js';

const pool = createPool(env);
pool.on('error', () => {});
const storage = createStorageClient(env);

try {
  const [health, minio] = await Promise.all([
    createHealthCheck({ pool, env })(),
    measureDependency(() => verifyBucket(storage, env.S3_BUCKET)),
  ]);

  const [major, minor] = process.versions.node.split('.').map(Number);
  const supportedNode = major > 22 || (major === 22 && minor >= 12);
  const ok = supportedNode && health.status === 'ok' && minio.status === 'up';

  console.log(JSON.stringify({
    status: ok ? 'ok' : 'failed',
    node: process.version,
    configuration: 'valid',
    aiEnabled: env.AI_ENABLED,
    postgres: health.dependencies.postgres,
    redis: health.dependencies.redis,
    minio: { ...minio, bucket: env.S3_BUCKET },
  }, null, 2));

  if (!ok) {
    console.error('Check Docker service readiness and run npm run infra:up. No service success is inferred from configuration alone.');
    process.exitCode = 1;
  }
} finally {
  await pool.end();
  storage.destroy();
}
