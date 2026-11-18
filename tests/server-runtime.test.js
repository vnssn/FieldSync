import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createFixture } from './helpers/m5.js';
import { startServer } from '../apps/server/src/server.js';
import { createPool } from '../apps/server/src/infrastructure/database.js';
import { createEvidenceStorage } from '../apps/server/src/infrastructure/storage.js';

let f;
before(async () => { f = await createFixture('m5inline'); });
after(async () => { await f?.close(); });

function resources(extra = {}) {
  const settings = { ...f.settings, API_HOST: '127.0.0.1', API_PORT: 0, SERVE_WEB: false, ...extra };
  return { settings, logger: f.logger, pool: createPool(settings, { schema: f.schema }), storage: createEvidenceStorage(settings) };
}

test('API stays healthy with the inline worker disabled and closes its owned pool', async () => {
  const owned = resources({ RUN_INLINE_WORKER: false });
  const app = startServer(owned);
  try {
    await once(app.server, 'listening');
    assert.equal(app.runtime, undefined);
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/v1/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).dependencies.redis.status, 'up');
  } finally { await app.shutdown('test'); }
  assert.equal(owned.pool.ended, true);
  assert.equal(app.server.listening, false);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`${signal} drains an actual inline BullMQ job before closing shared storage/PostgreSQL`, async () => {
    const row = await f.fresh();
    const attached = await f.attach(row, { ready: false });
    const owned = resources({ RUN_INLINE_WORKER: true });
    const originalRead = owned.storage.read;
    let storageDestroyed = false;
    const destroy = owned.storage.client.destroy.bind(owned.storage.client);
    owned.storage.client.destroy = () => { storageDestroyed = true; destroy(); };
    let release;
    const blocked = new Promise((done) => { release = done; });
    let entered;
    const processing = new Promise((done) => { entered = done; });
    owned.storage.read = async (...args) => {
      entered();
      await blocked;
      return originalRead(...args);
    };
    const listeners = process.listenerCount(signal);
    const app = startServer(owned);
    try {
      await once(app.server, 'listening');
      await app.runtime.queue.waitUntilReady();
      await Promise.race([processing, new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Inline evidence job did not start')), 10000);
        timer.unref();
        processing.finally(() => clearTimeout(timer));
      })]);
      assert.equal(process.listenerCount(signal), listeners + 1);
      process.emit(signal);
      const closing = app.shutdown('duplicate');
      assert.equal(closing, app.shutdown('duplicate-again'));
      assert.equal(owned.pool.ended, false);
      assert.equal(storageDestroyed, false);
      release();
      await closing;
      const result = await f.pool.query('SELECT processing_status FROM evidence WHERE id=$1', [attached.evidence.id]);
      assert.equal(result.rows[0].processing_status, 'ready');
      assert.equal(owned.pool.ended, true);
      assert.equal(storageDestroyed, true);
      assert.equal(app.server.listening, false);
      assert.equal(process.listenerCount(signal), listeners);
      await assert.rejects(owned.pool.query('SELECT 1'), /calling end/);
    } finally {
      release();
      await app.shutdown('test-cleanup');
    }
  });
}

test('a listener startup failure closes the inline runtime and sets a failing exit code', async () => {
  const originalExitCode = process.exitCode;
  const owned = resources({ RUN_INLINE_WORKER: true, API_PORT: f.server.address().port });
  const app = startServer(owned);
  try {
    const [error] = await once(app.server, 'error');
    assert.equal(error.code, 'EADDRINUSE');
    await app.shutdown('test');
    assert.equal(owned.pool.ended, true);
    assert.equal(app.server.listening, false);
    assert.equal(process.exitCode, 1);
  } finally {
    await app.shutdown('test-cleanup');
    process.exitCode = originalExitCode;
  }
});
