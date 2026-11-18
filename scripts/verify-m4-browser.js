import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname, basename } from 'node:path';
import express from 'express';
import { Queue } from 'bullmq';
import { DeleteBucketCommand } from '@aws-sdk/client-s3';
import { env } from '../apps/server/src/config/env.js';
import { createPool } from '../apps/server/src/infrastructure/database.js';
import { runMigrations } from '../apps/server/src/infrastructure/migrations.js';
import { createLogger } from '../apps/server/src/infrastructure/logger.js';
import { createEvidenceStorage, ensureBucket } from '../apps/server/src/infrastructure/storage.js';
import { createJobRuntime } from '../apps/server/src/modules/jobs/worker.js';
import { createApp } from '../apps/server/src/app.js';
import { initialCopy } from '../apps/web/src/offline/state.js';

const repo = fileURLToPath(new URL('../', import.meta.url)), local = resolve(repo, '.local');
const { chromium, request } = await import(pathToFileURL(resolve(repo, process.env.FIELDSYNC_PLAYWRIGHT_PATH ?? '.local/qa/node_modules/playwright/index.mjs')).href);
const origin = new URL(env.APP_ORIGIN).origin, address = new URL(origin);
assert.equal(address.protocol, 'http:');
assert.ok(['localhost', '127.0.0.1'].includes(address.hostname), 'M4 browser verification needs a local APP_ORIGIN');
await mkdir(local, { recursive: true });
const profile = await mkdtemp(resolve(local, 'm4-profile-')), runId = randomUUID();
const schema = `fieldsync_m4ui_${runId.replaceAll('-', '')}`, bucket = `fieldsync-m4ui-${runId}`;
const settings = { ...env, S3_BUCKET: bucket, QUEUE_PREFIX: schema };
const adminPool = createPool(env), pool = createPool(env, { schema }), storage = createEvidenceStorage(settings);
const server = createServer(), password = 'M4-browser-password-27', errors = [];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jKxkAAAAASUVORK5CYII=', 'base64');
const wav = Buffer.alloc(46);
wav.write('RIFF'); wav.writeUInt32LE(38, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(2, 40);
let context, page, adminAPI, workerAPI, runtime, bucketCreated = false;
const storageRequests = [];
try {
  // Match the configured MinIO CORS origin. EADDRINUSE fails without disturbing
  // any user-started process; this temporary listener is always closed.
  await new Promise((res, rej) => { server.once('error', rej); server.listen(Number(address.port || 80), '127.0.0.1', res); });
  assert.match(schema, /^fieldsync_m4ui_[a-f0-9]{32}$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  await runMigrations(pool, { info() {}, warn() {}, error() {} }, schema);
  await ensureBucket(storage.client, bucket, env.S3_REGION); bucketCreated = true;
  const app = createApp({ pool, env: settings, storage, logger: createLogger('silent'), getHealth: async () => ({}) });
  const host = express(), dist = resolve(repo, 'apps/web/dist');
  host.use((req, res, next) => req.path.startsWith('/api/') ? app(req, res) : next());
  host.use(express.static(dist)); host.use((_req, res) => res.sendFile(resolve(dist, 'index.html')));
  server.on('request', host);
  adminAPI = await request.newContext({ baseURL: origin, extraHTTPHeaders: { Origin: origin } });
  workerAPI = await request.newContext({ baseURL: origin, extraHTTPHeaders: { Origin: origin } });
  async function post(api, path, body) {
    const response = await api.post(`/api/v1${path}`, { data: body });
    assert.ok(response.ok(), `${path}: ${response.status()}`); return response.json();
  }
  const identity = await post(adminAPI, '/auth/register-org', { organizationName: 'M4 Browser', name: 'Admin', email: 'admin@example.test', password });
  const worker = await post(adminAPI, '/users', { name: 'Worker', email: 'worker@example.test', password });
  await post(workerAPI, '/auth/login', { organizationId: identity.organization.id, email: worker.email, password });
  const asset = await post(adminAPI, '/assets', { code: 'M4-PUMP', name: 'Pump', category: 'Pumps', location: 'Yard' });
  const template = await post(adminAPI, '/templates', { name: 'Evidence checklist', description: '', items: [{ id: randomUUID(), label: 'Pressure' }], mutationId: randomUUID() });
  const assigned = () => post(adminAPI, '/inspections', { assetId: asset.id, templateId: template.id, assignedTo: worker.id, mutationId: randomUUID() });
  const upgrade = await assigned(), replay = await assigned(), merged = await assigned();
  const dbName = `fieldsync:${identity.organization.id}:${worker.id}`;
  runtime = createJobRuntime({ pool, storage, env: settings, logger: createLogger('silent'), intervalMs: 100 });
  await runtime.worker.pause(true);
  async function launch(offline = false) {
    context = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true, viewport: { width: 1440, height: 1000 } });
    context.on('request', (request) => {
      if (request.url().startsWith(`${settings.S3_PUBLIC_ENDPOINT.replace(/\/$/, '')}/${bucket}/`) && request.method() !== 'OPTIONS') {
        storageRequests.push({ method: request.method(), headers: request.headers() });
      }
    });
    await context.setOffline(offline); page = context.pages()[0] ?? await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
  }
  async function state() {
    return page.evaluate(async (name) => {
      const db = await new Promise((res, rej) => { const open = indexedDB.open(name); open.onsuccess = () => res(open.result); open.onerror = () => rej(open.error); });
      try {
        const result = { version: db.version };
        for (const table of ['workingCopies', 'outbox', 'records', 'files', 'blobs']) {
          const rows = await new Promise((res, rej) => { const tx = db.transaction(table), read = tx.objectStore(table).getAll(); read.onsuccess = () => res(read.result); read.onerror = () => rej(read.error); });
          result[table] = table === 'blobs' ? rows.map((row) => ({ id: row.id, size: row.blob.size })) : rows;
        }
        return result;
      } finally { db.close(); }
    }, dbName);
  }
  async function wait(check, label, timeout = 40000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await check()) return; await page.waitForTimeout(100); }
    throw new Error(`Timed out waiting for ${label}`);
  }
  async function open(id) {
    await page.goto(`${origin}/inspections/${id}`);
    await page.getByRole('heading', { name: 'Complete checklist', exact: true }).waitFor();
    await wait(async () => !(await page.getByLabel('Outcome', { exact: true }).isDisabled()), 'editor lock');
  }
  async function queueEmpty(id) { await wait(async () => !(await state()).outbox.some((entry) => entry.inspectionId === id), 'empty outbox'); }
  async function current(id) { return (await (await workerAPI.get(`/api/v1/inspections/${id}`)).json()).inspection; }
  await launch(); await page.goto(`${origin}/login`);
  const owner = { organizationId: identity.organization.id, userId: worker.id }, copy = initialCopy(owner, upgrade);
  copy.content.reportText = 'M3 pending draft survives the M4 upgrade'; copy.generation = 1;
  const mutationId = randomUUID();
  await page.evaluate(async ({ name, owner, row, copy, mutationId }) => {
    // Dexie version 1 is native IndexedDB version 10. Seed a valid M3 pending
    // draft, including rows written before the evidence response field existed.
    delete row.evidence; delete copy.base.evidence;
    const db = await new Promise((res, rej) => {
      const open = indexedDB.open(name, 10);
      open.onupgradeneeded = () => {
        const db = open.result; db.createObjectStore('records', { keyPath: 'id' }); db.createObjectStore('workingCopies', { keyPath: 'id' });
        const outbox = db.createObjectStore('outbox', { keyPath: 'sequence', autoIncrement: true });
        outbox.createIndex('mutationId', 'mutationId', { unique: true }); outbox.createIndex('inspectionId', 'inspectionId'); outbox.createIndex('status', 'status');
      };
      open.onsuccess = () => res(open.result); open.onerror = () => rej(open.error);
    });
    try {
      await new Promise((res, rej) => {
        const tx = db.transaction(['records', 'workingCopies', 'outbox'], 'readwrite');
        tx.objectStore('records').put({ ...owner, id: row.id, inspection: row, detail: null, unavailable: false });
        tx.objectStore('workingCopies').put(copy);
        tx.objectStore('outbox').add({ ...owner, mutationId, inspectionId: row.id, action: 'save', body: { ...copy.content, mutationId, baseVersion: 1 },
          base: row, generation: 1, status: 'pending', attemptedAt: null, error: null });
        tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
      });
    } finally { db.close(); }
  }, { name: dbName, owner, row: upgrade, copy, mutationId });
  await page.getByLabel('Organization ID').fill(identity.organization.id);
  await page.getByLabel('Email', { exact: true }).fill(worker.email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await page.waitForURL(`${origin}/`);
  await open(upgrade.id); await queueEmpty(upgrade.id);
  assert.equal((await state()).version, 20);
  assert.equal((await current(upgrade.id)).reportText, copy.content.reportText);
  console.log('PASS: additive Dexie v1-to-v2 upgrade preserves and replays an existing M3 pending draft.');

  await open(replay.id); await page.waitForFunction(() => !!navigator.serviceWorker.controller); await context.setOffline(true);
  await page.getByLabel('Outcome', { exact: true }).selectOption('pass');
  await page.getByLabel('Report summary', { exact: true }).fill('Photos and audio captured offline');
  await page.getByText('Saved on this device.', { exact: true }).waitFor();
  await page.getByLabel('Evidence file', { exact: true }).setInputFiles({ name: 'field.png', mimeType: 'image/png', buffer: png });
  await page.evaluate(() => {
    window.m4Put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (this.name === 'blobs') throw new DOMException('Injected blob quota failure', 'QuotaExceededError');
      return window.m4Put.call(this, value, ...args);
    };
  });
  await page.getByRole('button', { name: 'Attach file', exact: true }).click();
  await page.getByText('Injected blob quota failure', { exact: false }).waitFor();
  assert.equal((await state()).files.length, 0); assert.equal((await state()).blobs.length, 0);
  assert.equal((await state()).outbox.some((entry) => entry.action === 'attach'), false);
  await page.evaluate(() => { IDBObjectStore.prototype.put = window.m4Put; delete window.m4Put; });
  await page.getByRole('button', { name: 'Attach file', exact: true }).click();
  await wait(async () => (await state()).files.length === 1, 'photo commit');
  await page.getByLabel('Evidence file', { exact: true }).setInputFiles({ name: 'note.wav', mimeType: 'audio/wav', buffer: wav });
  await page.getByRole('button', { name: 'Attach file', exact: true }).click();
  await wait(async () => (await state()).files.length === 2, 'audio commit');
  await page.getByRole('button', { name: 'Submit for review', exact: true }).click();
  await wait(async () => (await state()).outbox.filter((entry) => entry.inspectionId === replay.id).length === 4, 'ordered file submission');
  assert.deepEqual((await state()).outbox.filter((entry) => entry.inspectionId === replay.id).map((entry) => entry.action), ['save', 'attach', 'attach', 'submit']);
  assert.deepEqual((await state()).blobs.map((row) => row.size).sort((a, b) => a - b), [wav.length, png.length].sort((a, b) => a - b));
  await page.reload(); await page.getByText('Submission queued. Local work is retained until acknowledged.', { exact: true }).waitFor();
  await context.close(); context = null; await launch(true); await page.goto(`${origin}/inspections/${replay.id}`);
  await page.getByText('Submission queued. Local work is retained until acknowledged.', { exact: true }).waitFor();
  assert.equal((await state()).blobs.length, 2);
  await context.setOffline(false);
  await page.getByText('Evidence verification is still running. Submission will retry automatically.', { exact: true }).waitFor({ timeout: 30000 });
  assert.equal((await state()).blobs.length, 0);
  assert.equal((await current(replay.id)).status, 'draft');
  await runtime.worker.resume(); await queueEmpty(replay.id);
  assert.equal((await current(replay.id)).status, 'submitted');
  assert.equal((await current(replay.id)).evidence.length, 2);
  assert.ok(storageRequests.length >= 2);
  assert.ok(storageRequests.some((request) => request.headers['content-type'] === 'image/png'));
  assert.ok(storageRequests.some((request) => request.headers['content-type'] === 'audio/wav'));
  for (const request of storageRequests) {
    assert.equal(request.method, 'PUT');
    assert.match(request.headers['x-amz-meta-sha256'], /^[a-f0-9]{64}$/);
    assert.equal(request.headers.cookie, undefined);
  }
  assert.equal(await page.getByRole('button', { name: 'Attach file', exact: true }).count(), 0);
  await page.getByRole('link', { name: 'Open printable archive', exact: true }).waitFor({ timeout: 30000 });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: resolve(local, 'm4-evidence-mobile.png'), fullPage: true });
  console.log('PASS: transactional blob quota rollback/retry, offline photo/audio persistence, reload/browser restart, raw PUT uploads with signed type/hash and no cookies, verification-gated submission and BullMQ report archive.');

  await page.setViewportSize({ width: 1440, height: 1000 }); await open(merged.id); await context.setOffline(true);
  await page.getByLabel('Evidence file', { exact: true }).setInputFiles({ name: 'retained.png', mimeType: 'image/png', buffer: png });
  await page.getByRole('button', { name: 'Attach file', exact: true }).click();
  await wait(async () => (await state()).outbox.some((entry) => entry.inspectionId === merged.id), 'retained file');
  const path = `**/api/v1/inspections/${merged.id}/evidence`; let lose = true;
  await page.route(path, async (route) => {
    const response = await route.fetch();
    if (route.request().method() === 'POST' && response.ok() && lose) { lose = false; await context.setOffline(true); await route.abort('failed'); }
    else await route.fulfill({ response });
  });
  await context.setOffline(false);
  await wait(async () => !lose, 'attachment commit with lost response');
  const committed = await current(merged.id);
  assert.equal(committed.evidence.length, 1);
  const response = await workerAPI.patch(`/api/v1/inspections/${merged.id}`, { data: {
    answers: committed.answers, reportText: 'Remote report preserved', baseVersion: committed.version, mutationId: randomUUID(),
  } });
  assert.ok(response.ok()); const remote = await response.json();
  // Inject a valid conflict state for the explicit-review recovery branch. The
  // remote already contains the file, so confirmation must also clear its blob.
  await page.evaluate(async ({ name, id, remote }) => {
    const db = await new Promise((res, rej) => { const open = indexedDB.open(name); open.onsuccess = () => res(open.result); open.onerror = () => rej(open.error); });
    try {
      await new Promise((res, rej) => {
        const tx = db.transaction(['outbox', 'workingCopies'], 'readwrite');
        const head = tx.objectStore('outbox').index('inspectionId').get(id);
        head.onsuccess = () => {
          tx.objectStore('outbox').put({ ...head.result, status: 'conflict', error: 'Injected explicit review after lost response' });
          const read = tx.objectStore('workingCopies').get(id);
          read.onsuccess = () => tx.objectStore('workingCopies').put({ ...read.result, conflict: { base: head.result.base, remote }, blocked: null });
        };
        tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
      });
    } finally { db.close(); }
  }, { name: dbName, id: merged.id, remote });
  await page.unroute(path); await context.setOffline(false);
  await page.getByRole('button', { name: 'Save merged draft', exact: true }).click(); await queueEmpty(merged.id);
  assert.equal((await state()).blobs.length, 0);
  assert.ok((await state()).files.every((file) => file.status === 'synced'));
  assert.equal((await current(merged.id)).evidence.length, 1);
  assert.equal((await current(merged.id)).reportText, 'Remote report preserved');
  const urls = await page.evaluate(async () => { const urls = []; for (const name of await caches.keys()) for (const row of await (await caches.open(name)).keys()) urls.push(row.url); return urls; });
  assert.ok(urls.every((url) => !url.includes('/api/') && !url.includes(':9000/')));
  assert.deepEqual(errors, []);
  console.log('PASS: lost-response file retention, explicit merge acknowledges existing membership and frees blobs, mobile layout, shell-only cache and zero page errors.');
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: resolve(local, 'm4-browser-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await context?.close(); await adminAPI?.dispose(); await workerAPI?.dispose(); await runtime?.close();
  if (server.listening) await new Promise((res) => { server.close(res); server.closeAllConnections(); });
  if (runtime) {
    const queue = new Queue('fieldsync-jobs', { connection: { host: env.REDIS_HOST, port: env.REDIS_PORT, password: env.REDIS_PASSWORD, maxRetriesPerRequest: 1 }, prefix: schema });
    try { await queue.obliterate({ force: true }); } finally { await queue.close(); }
  }
  if (bucketCreated) {
    for await (const object of storage.objects()) await storage.remove(object.Key);
    await storage.client.send(new DeleteBucketCommand({ Bucket: bucket }));
  }
  storage.client.destroy(); await pool.end();
  try { assert.match(schema, /^fieldsync_m4ui_[a-f0-9]{32}$/); await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
  finally { await adminPool.end(); }
  assert.equal(dirname(profile), local); assert.match(basename(profile), /^m4-profile-[a-zA-Z0-9]+$/);
  await rm(profile, { recursive: true, force: true });
  console.log('Cleaned up browser/profile, temporary listener, worker/queue, isolated bucket, pools and schema.');
}
