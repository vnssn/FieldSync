import { env } from '../../apps/server/src/config/env.js';
import { createPool } from '../../apps/server/src/infrastructure/database.js';
import { createEvidenceStorage } from '../../apps/server/src/infrastructure/storage.js';
import { processJob } from '../../apps/server/src/modules/jobs/worker.js';

const [schema, bucket, organizationId, jobId] = process.argv.slice(2);
if (!/^fieldsync_m4_[a-f0-9]{32}$/.test(schema) || !/^fieldsync-m4-[a-f0-9-]{36}$/.test(bucket)) throw new Error('Invalid test namespace');
const pool = createPool(env, { schema }), storage = createEvidenceStorage({ ...env, S3_BUCKET: bucket });
// Crash after the real durable claim, at the boundary before an external read.
// The parent kills this process and the real BullMQ runtime recovers its lease.
storage.read = async () => { process.send({ claimed: true }); await new Promise(() => {}); };
processJob({ pool, storage }, { organizationId, jobId }).catch(async () => {
  process.send({ claimed: false });
  storage.client.destroy(); await pool.end(); process.exitCode = 1;
});
