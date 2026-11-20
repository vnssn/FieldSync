import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { env } from './config/env.js';
import { createLogger } from './infrastructure/logger.js';
import { createPool } from './infrastructure/database.js';
import { createHealthCheck } from './modules/health/service.js';
import { createApp } from './app.js';
import { createEvidenceStorage } from './infrastructure/storage.js';
import { createJobRuntime } from './modules/jobs/worker.js';

export function startServer({
  settings = env,
  logger = createLogger(settings.LOG_LEVEL),
  pool = createPool(settings),
  storage = createEvidenceStorage(settings),
} = {}) {
  const onPoolError = () => logger.error('An idle PostgreSQL connection failed');
  pool.on('error', onPoolError);

  const getHealth = createHealthCheck({ pool, env: settings, logger });
  const webDirectory = settings.SERVE_WEB ? fileURLToPath(new URL('../../web/dist/', import.meta.url)) : undefined;
  if (webDirectory && !existsSync(`${webDirectory}/index.html`)) throw new Error('Build the web client before starting SERVE_WEB.');
  const app = createApp({ getHealth, logger, pool, env: settings, storage, webDirectory });
  // The HTTP API and worker share their pool/storage; only this owner closes them.
  const runtime = settings.RUN_INLINE_WORKER ? createJobRuntime({ pool, storage, env: settings, logger,
    idleIntervalMs:settings.JOBS_IDLE_INTERVAL_MS ?? 1800000 }) : undefined;
  if (runtime) logger.info('FieldSync inline background worker started');

  const server = createServer(app);
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;

  let stopping;
  function shutdown(signal, exitCode = 0) {
    if (exitCode) process.exitCode = exitCode;
    if (stopping) return stopping;
    logger.info({ signal }, 'Shutting down');
    const deadline = setTimeout(() => process.exit(1), 10000);
    deadline.unref();
    stopping = (async () => {
      const requestsClosed = new Promise((done) => server.close(() => done()));
      server.closeIdleConnections();
      // Drain HTTP and jobs before destroying the dependencies either can use.
      const results = await Promise.allSettled([requestsClosed, runtime?.close()]);
      try {
        if (results.some((result) => result.status === 'rejected')) {
          throw new Error('Background worker shutdown failed');
        }
      } finally {
        storage.client.destroy();
        await pool.end();
      }
    })().catch(() => {
      logger.error('API/inline worker shutdown failed');
      process.exitCode = 1;
    }).finally(() => {
      clearTimeout(deadline);
      pool.off('error', onPoolError);
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    });
    return stopping;
  }

  const onSigint = () => void shutdown('SIGINT');
  const onSigterm = () => void shutdown('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  server.on('error', (error) => {
    logger.error({ code: error.code, port: settings.API_PORT }, 'Could not start API');
    void shutdown('server-error', 1);
  });
  server.listen(settings.API_PORT, settings.API_HOST, () => {
    logger.info({ host: settings.API_HOST, port: settings.API_PORT, aiEnabled: settings.AI_ENABLED,
      inlineWorker: settings.RUN_INLINE_WORKER }, 'FieldSync API listening');
  });
  return { server, runtime, shutdown };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) startServer();
