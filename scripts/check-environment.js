import { env } from '../apps/server/src/config/env.js';
import { createPool } from '../apps/server/src/infrastructure/database.js';
import { createHealthCheck, measureDependency } from '../apps/server/src/modules/health/service.js';
import { createEvidenceStorage } from '../apps/server/src/infrastructure/storage.js';

const pool = createPool(env);
pool.on('error', () => {});
const storage = createEvidenceStorage(env);

try {
  const [health, minio] = await Promise.all([
    createHealthCheck({ pool, env })(),
    measureDependency(() => storage.verify()),
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
    storage: { ...minio, provider: env.EVIDENCE_STORAGE_PROVIDER },
  }, null, 2));

  if (!ok) {
    console.error('Check database, Redis and the selected evidence storage provider. No service success is inferred from configuration alone.');
    process.exitCode = 1;
  }
} finally {
  await pool.end();
  storage.client.destroy();
}
