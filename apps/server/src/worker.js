import { env } from './config/env.js';
import { createLogger } from './infrastructure/logger.js';
import { createPool } from './infrastructure/database.js';
import { createEvidenceStorage } from './infrastructure/storage.js';
import { createJobRuntime } from './modules/jobs/worker.js';

const logger = createLogger(env.LOG_LEVEL), pool = createPool(env), storage = createEvidenceStorage(env);
pool.on('error',() => logger.error('Background PostgreSQL connection failed'));
const runtime = createJobRuntime({ pool,storage,env,logger });
logger.info('FieldSync background worker started');
let stopping=false;
async function shutdown() {
  if(stopping) return; stopping=true;
  const deadline = setTimeout(() => process.exit(1),10000); deadline.unref();
  try { await runtime.close(); }
  finally { storage.client.destroy(); await pool.end(); }
  clearTimeout(deadline);
}
const stop = () => void shutdown().catch(() => { logger.error('Background worker shutdown failed'); process.exitCode = 1; });
process.once('SIGINT',stop); process.once('SIGTERM',stop);
