import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname, basename } from 'node:path';
import express from 'express';
import { env } from '../apps/server/src/config/env.js';
import { createPool } from '../apps/server/src/infrastructure/database.js';
import { runMigrations } from '../apps/server/src/infrastructure/migrations.js';
import { createLogger } from '../apps/server/src/infrastructure/logger.js';
import { createApp } from '../apps/server/src/app.js';

// Uses the existing local QA installation, or an explicitly supplied Playwright
// module path. Playwright is not a FieldSync dependency or runtime service.
const repo = fileURLToPath(new URL('../', import.meta.url));
const { chromium, request } = await import(pathToFileURL(resolve(repo, process.env.FIELDSYNC_PLAYWRIGHT_PATH ?? '.local/qa/node_modules/playwright/index.mjs')).href);
const local = resolve(repo, '.local'); await mkdir(local, { recursive: true });
const profile = await mkdtemp(resolve(local, 'm3-profile-'));
const schema = `fieldsync_m3ui_${randomUUID().replaceAll('-', '')}`;
const adminPool = createPool(env), pool = createPool(env, { schema });
const server = createServer(); const password = 'M3-browser-password-27';
let context, page, adminAPI, workerAPI, otherAPI;
const errors = [];
try {
  assert.match(schema, /^fieldsync_m3ui_[a-f0-9]{32}$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  await runMigrations(pool, { info() {}, warn() {}, error() {} }, schema);
  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const app = createApp({ pool, env: { ...env, APP_ORIGIN: origin }, logger: createLogger('silent'), getHealth: async () => ({}) });
  const host = express(), dist = resolve(repo, 'apps/web/dist');
  host.use((req, res, next) => req.path.startsWith('/api/') ? app(req, res) : next());
  host.use(express.static(dist)); host.use((_req, res) => res.sendFile(resolve(dist, 'index.html')));
  server.on('request', host);
  adminAPI = await request.newContext({ baseURL: origin, extraHTTPHeaders: { Origin: origin } });
  workerAPI = await request.newContext({ baseURL: origin, extraHTTPHeaders: { Origin: origin } });
  otherAPI = await request.newContext({ baseURL: origin, extraHTTPHeaders: { Origin: origin } });
  async function post(api, path, body) {
    const response = await api.post(`/api/v1${path}`, { data: body });
    assert.ok(response.ok(), `${path}: ${response.status()} ${await response.text()}`); return response.json();
  }
  const identity = await post(adminAPI, '/auth/register-org', { organizationName: 'M3 Smoke', name: 'Admin', email: 'admin@example.test', password });
  const worker = await post(adminAPI, '/users', { name: 'Worker', email: 'worker@example.test', password });
  const worker2 = await post(adminAPI, '/users', { name: 'Second worker', email: 'second@example.test', password });
  const asset = await post(adminAPI, '/assets', { code: 'M3-PUMP', name: 'Pump', category: 'Pumps', location: 'Yard' });
  const template = await post(adminAPI, '/templates', { name: 'Safety checklist', description: '', items: [{ id: randomUUID(), label: 'Pressure' }], mutationId: randomUUID() });
  await post(workerAPI, '/auth/login', { organizationId: identity.organization.id, email: worker.email, password });
  const other = await post(otherAPI, '/auth/register-org', { organizationName: 'Other tenant', name: 'Other admin', email: 'admin@example.test', password });
  const otherWorker = await post(otherAPI, '/users', { name: 'Other worker', email: 'other@example.test', password });
  const assigned = () => post(adminAPI, '/inspections', { assetId: asset.id, templateId: template.id, assignedTo: worker.id, mutationId: randomUUID() });
  const replay = await assigned(), conflict = await assigned(), retained = await assigned(), expired = await assigned(), reassigned = await assigned(), quota = await assigned();
  const dbName = `fieldsync:${identity.organization.id}:${worker.id}`;
  function observe(tab) { tab.on('pageerror', (error) => errors.push(error.message)); }
  async function launch(offline = false) {
    context = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true, viewport: { width: 1440, height: 1000 } });
    await context.setOffline(offline); page = context.pages()[0] ?? await context.newPage(); observe(page);
  }
  async function login(org, email) {
    await page.goto(`${origin}/login`);
    await page.getByLabel('Organization ID').fill(org);
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL(`${origin}/`);
  }
  async function open(id) {
    await page.goto(`${origin}/inspections/${id}`);
    await page.getByRole('heading', { name: 'Complete checklist', exact: true }).waitFor();
    await page.getByLabel('Report summary', { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('textarea[maxlength="10000"]').disabled && !document.querySelector('textarea[maxlength="10000"]').closest('fieldset').disabled);
  }
  async function deviceSaved() { await page.getByText('Saved on this device.', { exact: true }).waitFor(); }
  async function localState() {
    return page.evaluate(async (name) => {
      const db = await new Promise((res, rej) => { const open = indexedDB.open(name); open.onsuccess = () => res(open.result); open.onerror = () => rej(open.error); });
      try {
        const result = {};
        for (const table of ['workingCopies', 'outbox', 'records']) result[table] = await new Promise((res, rej) => {
          const tx = db.transaction(table), read = tx.objectStore(table).getAll(); read.onsuccess = () => res(read.result); read.onerror = () => rej(read.error);
        });
        return result;
      } finally { db.close(); }
    }, dbName);
  }
  async function waitQueue(id, count) {
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await localState()).outbox.filter((entry) => entry.inspectionId === id).length === count) return;
      await page.waitForTimeout(100);
    }
    throw new Error(`Queue for ${id} did not reach ${count}`);
  }
  async function detail(id) { return (await (await workerAPI.get(`/api/v1/inspections/${id}`)).json()).inspection; }
  async function remoteSave(id, text) {
    const row = await detail(id);
    const response = await workerAPI.patch(`/api/v1/inspections/${id}`, { data: { answers: row.answers, reportText: text, baseVersion: row.version, mutationId: randomUUID() } });
    assert.equal(response.status(), 200); return response.json();
  }

  await launch(); await login(identity.organization.id, worker.email); await open(replay.id);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await context.setOffline(true);
  await page.getByLabel('Outcome', { exact: true }).selectOption('pass');
  await page.getByLabel('Report summary', { exact: true }).fill('Saved and submitted offline'); await deviceSaved();
  await page.getByRole('button', { name: 'Submit for review', exact: true }).click(); await waitQueue(replay.id, 2);
  let stored = await localState();
  const queue = stored.outbox.filter((entry) => entry.inspectionId === replay.id);
  assert.deepEqual(queue.map((entry) => entry.action), ['save', 'submit']);
  assert.ok(queue.every((entry) => entry.organizationId === identity.organization.id && entry.userId === worker.id));
  await page.reload(); await page.getByText('Submission queued. Local work is retained until acknowledged.', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Report summary', { exact: true }).inputValue(), 'Saved and submitted offline');
  await context.close(); context = null;
  await launch(true); await page.goto(`${origin}/inspections/${replay.id}`);
  await page.getByText('Submission queued. Local work is retained until acknowledged.', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Report summary', { exact: true }).inputValue(), 'Saved and submitted offline');
  await context.setOffline(false); await waitQueue(replay.id, 0);
  assert.equal((await detail(replay.id)).version, 3); assert.equal((await detail(replay.id)).status, 'submitted');
  const receipts = await pool.query('SELECT count(*)::int AS count FROM mutation_receipts WHERE inspection_id = $1 AND user_id = $2', [replay.id, worker.id]);
  assert.equal(receipts.rows[0].count, 2);
  console.log('PASS: actual IndexedDB, atomic save/submission, offline reload and full browser restart, reconnect replay, versions and receipts.');

  await open(conflict.id); await context.setOffline(true);
  await page.getByLabel('Outcome', { exact: true }).selectOption('pass');
  await page.getByLabel('Report summary', { exact: true }).fill('Local conflict edit'); await deviceSaved();
  assert.equal((await localState()).workingCopies.find((row) => row.id === conflict.id).content.answers[0].outcome, 'pass');
  const frozen = (await localState()).outbox.find((entry) => entry.inspectionId === conflict.id);
  const second = await context.newPage(); observe(second); await second.goto(`${origin}/inspections/${conflict.id}`);
  await second.getByRole('heading', { name: 'Complete checklist', exact: true }).waitFor();
  assert.equal(await second.getByLabel('Report summary', { exact: true }).isEnabled(), false);
  await remoteSave(conflict.id, 'Remote conflict edit'); await context.setOffline(false);
  await page.getByRole('heading', { name: 'Resolve sync conflict', exact: true }).waitFor();
  await second.getByRole('heading', { name: 'Resolve sync conflict', exact: true }).waitFor();
  await page.close(); page = second;
  await page.waitForFunction(() => !document.querySelector('textarea[maxlength="10000"]').closest('fieldset').disabled);
  assert.equal(await page.getByLabel('Report summary', { exact: true }).inputValue(), 'Local conflict edit');
  await page.getByLabel('This device: Local conflict edit', { exact: true }).check();
  await remoteSave(conflict.id, 'Newer remote conflict edit');
  await page.getByRole('button', { name: 'Submit merged report', exact: true }).click();
  await page.getByLabel('Server: Newer remote conflict edit', { exact: true }).waitFor();
  await page.getByLabel('This device: Local conflict edit', { exact: true }).check();
  await page.getByRole('button', { name: 'Submit merged report', exact: true }).click(); await waitQueue(conflict.id, 0);
  const merged = await detail(conflict.id); assert.equal(merged.version, 4); assert.equal(merged.reportText, 'Local conflict edit'); assert.equal(merged.status, 'submitted');
  const oldReceipt = await pool.query('SELECT outcome FROM mutation_receipts WHERE mutation_id = $1', [frozen.mutationId]);
  assert.equal(oldReceipt.rows[0].outcome.error.code, 'VERSION_CONFLICT');
  const mergedReceipt = await pool.query('SELECT mutation_id FROM mutation_receipts WHERE inspection_id = $1 AND user_id = $2 AND outcome ? $3', [conflict.id, worker.id, 'body']);
  assert.ok(mergedReceipt.rows.some((row) => row.mutation_id !== frozen.mutationId));
  console.log('PASS: exclusive two-tab editing, 409 preservation, fresh-remote recheck, explicit merge and new mutation receipt.');

  await open(retained.id); await context.setOffline(true);
  await page.getByLabel('Report summary', { exact: true }).fill('Private retained draft'); await deviceSaved();
  const mirror = await context.newPage(); observe(mirror); await mirror.goto(`${origin}/inspections`);
  await mirror.getByRole('heading', { name: 'Every check, accounted for.', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Log out', exact: true }).click(); await page.waitForURL('**/login');
  await mirror.waitForURL('**/login'); await mirror.close();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('fieldsync:session')).session), null);
  await context.setOffline(false); await login(other.organization.id, otherWorker.email); await page.goto(`${origin}/inspections`);
  assert.equal(await page.getByText('Private retained draft', { exact: true }).count(), 0);
  assert.equal((await detail(retained.id)).version, 1);
  assert.equal((await localState()).workingCopies.find((row) => row.id === retained.id).content.reportText, 'Private retained draft');
  assert.equal((await localState()).outbox.filter((row) => row.inspectionId === retained.id).length, 1);
  await page.getByRole('button', { name: 'Log out', exact: true }).click(); await page.waitForURL('**/login');
  await login(identity.organization.id, worker.email); await page.goto(`${origin}/inspections/${retained.id}`); await waitQueue(retained.id, 0);
  assert.equal((await detail(retained.id)).reportText, 'Private retained draft');
  console.log('PASS: offline logout, pending cookie logout, isolated tenant/user switch and replay only after returning to the original account.');

  await open(expired.id); await context.setOffline(true);
  await page.getByLabel('Report summary', { exact: true }).fill('Survives expired session'); await deviceSaved();
  await pool.query('DELETE FROM sessions WHERE organization_id = $1 AND user_id = $2', [identity.organization.id, worker.id]);
  await context.setOffline(false); await page.getByText('Sign in to resume sync.', { exact: false }).waitFor();
  assert.equal(await page.getByLabel('Report summary', { exact: true }).inputValue(), 'Survives expired session');
  assert.equal((await localState()).outbox.filter((row) => row.inspectionId === expired.id).length, 1);
  await page.getByRole('link', { name: 'Sign in', exact: true }).click(); await login(identity.organization.id, worker.email);
  await post(workerAPI, '/auth/login', { organizationId: identity.organization.id, email: worker.email, password });
  await page.goto(`${origin}/inspections/${expired.id}`); await waitQueue(expired.id, 0);
  assert.equal((await detail(expired.id)).reportText, 'Survives expired session');
  console.log('PASS: expired-session retention and reauthentication without replacing the local draft.');

  await open(reassigned.id); await context.setOffline(true);
  await page.getByLabel('Report summary', { exact: true }).fill('Retained after reassignment'); await deviceSaved();
  const reassignment = await adminAPI.patch(`/api/v1/inspections/${reassigned.id}/assignment`, { data: { assignedTo: worker2.id, baseVersion: 1, mutationId: randomUUID() } }); assert.equal(reassignment.status(), 200);
  await context.setOffline(false);
  await page.getByText('Local work is retained.', { exact: false }).first().waitFor();
  for (let attempt = 0; attempt < 100; attempt++) {
    stored = await localState(); if (stored.outbox.find((row) => row.inspectionId === reassigned.id)?.status === 'blocked') break;
    await page.waitForTimeout(100);
  }
  assert.equal(stored.outbox.find((row) => row.inspectionId === reassigned.id).status, 'blocked');
  assert.equal(await page.getByLabel('Report summary', { exact: true }).inputValue(), 'Retained after reassignment');
  assert.equal(await page.getByLabel('Report summary', { exact: true }).isEnabled(), false);
  const returned = await adminAPI.patch(`/api/v1/inspections/${reassigned.id}/assignment`, { data: { assignedTo: worker.id, baseVersion: 2, mutationId: randomUUID() } }); assert.equal(returned.status(), 200);
  await page.getByRole('button', { name: 'Review current assignment', exact: true }).click();
  await page.getByRole('heading', { name: 'Resolve sync conflict', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Save merged draft', exact: true }).click(); await waitQueue(reassigned.id, 0);
  assert.equal((await detail(reassigned.id)).reportText, 'Retained after reassignment');
  console.log('PASS: restored assignment explicitly reviewed and merged without discarding retained work.');

  await open(quota.id); await context.setOffline(true);
  await page.evaluate(() => {
    window.originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'workingCopies') throw new DOMException('Simulated storage quota', 'QuotaExceededError');
      return window.originalPut.apply(this, args);
    };
  });
  await page.getByLabel('Report summary', { exact: true }).fill('Buffered despite quota failure');
  await page.getByText('Device save failed. Keep this page open and retry.', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Report summary', { exact: true }).inputValue(), 'Buffered despite quota failure');
  assert.equal((await localState()).workingCopies.find((row) => row.id === quota.id).content.reportText, '');
  await page.evaluate(() => { IDBObjectStore.prototype.put = window.originalPut; delete window.originalPut; });
  await page.getByRole('button', { name: 'Retry device save', exact: true }).click(); await deviceSaved(); await waitQueue(quota.id, 1);
  assert.equal(await page.getByText('Failed to fetch', { exact: true }).count(), 0);
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: resolve(local, 'm3-offline-mobile.png'), fullPage: true });
  await context.setOffline(false); await waitQueue(quota.id, 0);
  assert.equal((await detail(quota.id)).reportText, 'Buffered despite quota failure');
  const cachedUrls = await page.evaluate(async () => {
    const urls = []; for (const name of await caches.keys()) for (const entry of await (await caches.open(name)).keys()) urls.push(entry.url); return urls;
  });
  assert.ok(cachedUrls.length >= 4); assert.ok(cachedUrls.every((url) => !url.includes('/api/')));
  assert.deepEqual(errors, []);
  console.log('PASS: reassignment retention/read-only mode, visible quota failure with buffer/retry, mobile layout, shell-only cache and zero page errors.');
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: resolve(local, 'm3-browser-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await context?.close(); await adminAPI?.dispose(); await workerAPI?.dispose(); await otherAPI?.dispose();
  if (server.listening) await new Promise((res) => { server.close(res); server.closeAllConnections(); });
  await pool.end();
  try { assert.match(schema, /^fieldsync_m3ui_[a-f0-9]{32}$/); await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
  finally { await adminPool.end(); }
  // Verify the exact generated target before recursive removal on Windows.
  assert.equal(dirname(profile), local); assert.match(basename(profile), /^m3-profile-[a-zA-Z0-9]+$/);
  await rm(profile, { recursive: true, force: true });
  console.log('Cleaned up browser profile, temporary listener, API contexts, pools and isolated schema.');
}
