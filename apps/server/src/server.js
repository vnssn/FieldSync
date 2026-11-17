import { createServer } from 'node:http';
import { env } from './config/env.js';
import { createLogger } from './infrastructure/logger.js';
import { createPool } from './infrastructure/database.js';
import { createHealthCheck } from './modules/health/service.js';
import { createApp } from './app.js';
import { createEvidenceStorage } from './infrastructure/storage.js';

const logger = createLogger(env.LOG_LEVEL);
const pool = createPool(env);
pool.on('error', () => logger.error('An idle PostgreSQL connection failed'));

const getHealth = createHealthCheck({ pool, env, logger });
const storage=createEvidenceStorage(env);
const app = createApp({ getHealth, logger, pool, env,storage });

const server = createServer(app);

server.on('error', async (error) => {
  logger.error({ code: error.code, port: env.API_PORT }, 'Could not start API');
  storage.client.destroy();
  await pool.end();
  process.exitCode = 1;
});

server.listen(env.API_PORT, env.API_HOST, () => {
  logger.info({ host: env.API_HOST, port: env.API_PORT, aiEnabled: env.AI_ENABLED }, 'FieldSync API listening');
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');
  const deadline = setTimeout(() => process.exit(1), 10000);
  deadline.unref();
  server.close(async () => {
    storage.client.destroy();
    await pool.end();
    clearTimeout(deadline);
    process.exitCode = 0;
  });
  server.closeIdleConnections();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
