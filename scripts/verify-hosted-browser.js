import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Explicitly opt in: this creates sample records and makes one real Groq call.
// All records belong to this runner's isolated organization; credentials and
// browser state stay in ignored .local, never in test output or source control.
const origin = process.env.FIELDSYNC_HOSTED_ORIGIN;
assert.equal(origin, 'https://fieldsync-six.vercel.app', 'Set FIELDSYNC_HOSTED_ORIGIN to the production Vercel origin to opt in.');
const repo = fileURLToPath(new URL('../', import.meta.url));
const local = resolve(repo, '.local/hosted-acceptance');
const credentialsFile = resolve(local, 'credentials.json');
const resultFile = resolve(local, 'result.json');
await mkdir(local, { recursive: true });
const profile = await mkdtemp(resolve(local, 'browser-profile-'));
const { chromium, request } = await import(pathToFileURL(resolve(repo,
  process.env.FIELDSYNC_PLAYWRIGHT_PATH ?? '.local/qa/node_modules/playwright/index.mjs')).href);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jKxkAAAAASUVORK5CYII=', 'base64');
const wav = Buffer.alloc(46);
wav.write('RIFF'); wav.writeUInt32LE(38, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(2, 40);
const results = { origin, startedAt: new Date().toISOString(), checks: [] };
let adminAPI, otherAPI, context, page, fixture;
const errors = [], uploadOrigins = new Set();
async function persist() { await writeFile(credentialsFile, JSON.stringify(fixture, null, 2), { mode: 0o600 }); }
async function api(client, method, path, body, expected = 200) {
  const response = await client.fetch(`/api/v1${path}`, { method, ...(body === undefined ? {} : { data: body }) });
  if (response.status() !== expected) {
    let code = 'unknown'; try { code = (await response.json()).error?.code ?? code; } catch {}
    throw new Error(`${method} ${path}: HTTP ${response.status()} (${code}), expected ${expected}`);
  }
  return expected === 204 ? undefined : response.json();
}
async function wait(check, label, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await new Promise(done => setTimeout(done, 500)); }
  throw new Error(`Timed out waiting for ${label}`);
}
async function evidenceCount(id, count) {
  await wait(async () => {
    const row = await detail(id);
    if (row.evidence.length === count) return true;
    const notice = await page.getByRole('alert').allTextContents();
    if (notice.some(text => /storage is unavailable|upload was interrupted/i.test(text))) {
      throw new Error(`Hosted evidence failed: ${notice.join(' ').slice(0, 300)}`);
    }
    return false;
  }, 'hosted evidence upload');
}
function pass(name, detail = {}) { results.checks.push({ name, ...detail }); console.log(`PASS: ${name}`); }
async function launch() {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'msedge', headless: true, viewport: { width: 1440, height: 1000 },
    baseURL: origin, extraHTTPHeaders: { Origin: origin },
  });
  page = context.pages()[0] ?? await context.newPage();
  page.setDefaultTimeout(40000);
  page.on('pageerror', error => errors.push(error.message));
  context.on('request', req => {
    if (req.method() === 'PUT' && req.url().includes('/content/')) uploadOrigins.add(new URL(req.url()).origin);
    if (req.url().includes('cloudinary.com')) errors.push('Browser contacted evidence provider directly');
  });
}
async function login() {
  await page.goto(`${origin}/login`);
  await page.getByLabel('Organization ID').fill(fixture.organizationId);
  await page.getByLabel('Email', { exact: true }).fill(fixture.workerEmail);
  await page.getByLabel('Password', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(`${origin}/`);
}
async function detail(id) { return (await api(context.request, 'GET', `/inspections/${id}`)).inspection; }
async function open(id) {
  await page.goto(`${origin}/inspections/${id}`);
  await page.getByRole('heading', { name: 'Complete checklist', exact: true }).waitFor();
  await wait(async () => !(await page.getByLabel('Outcome', { exact: true }).first().isDisabled()), 'editor lock');
}
async function deviceState() {
  return page.evaluate(async name => {
    const db = await new Promise((done, fail) => { const req = indexedDB.open(name); req.onsuccess = () => done(req.result); req.onerror = () => fail(req.error); });
    try {
      const result = {};
      for (const table of ['workingCopies', 'outbox', 'files', 'blobs']) {
        const rows = await new Promise((done, fail) => { const req = db.transaction(table).objectStore(table).getAll(); req.onsuccess = () => done(req.result); req.onerror = () => fail(req.error); });
        result[table] = table === 'blobs' ? rows.map(row => ({ id: row.id, size: row.blob.size })) : rows;
      }
      return result;
    } finally { db.close(); }
  }, `fieldsync:${fixture.organizationId}:${fixture.workerId}`);
}
async function empty(id) { await wait(async () => !(await deviceState()).outbox.some(row => row.inspectionId === id), 'device queue replay'); }
async function attach(name, mimeType, buffer) {
  await wait(async () => !(await page.getByLabel('Evidence file', { exact: true }).isDisabled()), 'file editor');
  await page.getByLabel('Evidence file', { exact: true }).setInputFiles({ name, mimeType, buffer });
  await page.getByRole('button', { name: 'Attach file', exact: true }).click();
}
async function checkDownload(id, file) {
  const response = await context.request.get(`/api/v1/inspections/${id}/evidence/${file.id}/download`);
  assert.equal(response.status(), 200); const bytes = await response.body();
  assert.equal(bytes.byteLength, file.size); assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
  assert.ok(response.headers()['cache-control'].split(',').map(value => value.trim()).includes('no-store'));
}
try {
  try { fixture = JSON.parse(await readFile(credentialsFile, 'utf8')); assert.equal(fixture.origin, origin); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const tag = randomUUID().slice(0, 8);
    fixture = { origin, password: randomBytes(24).toString('base64url'), adminEmail: `acceptance-admin-${tag}@example.test`,
      workerEmail: `acceptance-worker-${tag}@example.test`, otherEmail: `acceptance-other-${tag}@example.test`, tag };
    await persist();
  }
  adminAPI = await request.newContext({ baseURL: origin, extraHTTPHeaders: { Origin: origin }, timeout: 60000 });
  if (!fixture.organizationId) {
    const identity = await api(adminAPI, 'POST', '/auth/register-org', { organizationName: `FieldSync acceptance ${fixture.tag}`,
      name: 'Acceptance admin', email: fixture.adminEmail, password: fixture.password }, 201);
    fixture.organizationId = identity.organization.id; await persist();
  } else await api(adminAPI, 'POST', '/auth/login', { organizationId: fixture.organizationId, email: fixture.adminEmail, password: fixture.password });
  if (!fixture.workerId) {
    fixture.workerId = (await api(adminAPI, 'POST', '/users', { name: 'Acceptance worker', email: fixture.workerEmail, password: fixture.password }, 201)).id;
    await persist();
  }
  if (!fixture.assetId) {
    fixture.assetId = (await api(adminAPI, 'POST', '/assets', { code: `QA-${fixture.tag}`, name: 'Demo pump', category: 'Pumps', location: 'Acceptance sandbox' }, 201)).id;
    await persist();
  }
  if (!fixture.templateId) {
    fixture.templateId = (await api(adminAPI, 'POST', '/templates', { name: 'Acceptance checklist', description: 'Synthetic demo observations only',
      items: [{ id: randomUUID(), label: 'Pressure' }, { id: randomUUID(), label: 'Leaks' }], mutationId: randomUUID() }, 201)).id;
    await persist();
  }
  const assigned = () => api(adminAPI, 'POST', '/inspections', { assetId: fixture.assetId, templateId: fixture.templateId, assignedTo: fixture.workerId, mutationId: randomUUID() }, 201);
  const report = await assigned(), offline = await assigned();
  fixture.lastInspectionIds = [report.id, offline.id]; await persist();
  console.log('SETUP: isolated hosted inspection fixtures ready');
  await launch(); await login();
  const cookie = (await context.cookies(origin)).find(row => row.name === 'fieldsync_sid');
  assert.ok(cookie); assert.equal(cookie.domain, new URL(origin).hostname); assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.secure, true); assert.equal(cookie.sameSite, 'Lax');
  const browserIdentity = () => page.evaluate(async () => { const r = await fetch('/api/v1/auth/me'); return { status: r.status, body: await r.json() }; });
  assert.equal((await browserIdentity()).body.user.id, fixture.workerId);
  await page.reload(); assert.equal((await browserIdentity()).status, 200);
  await context.close(); context = undefined; await launch(); await page.goto(origin);
  assert.equal((await browserIdentity()).body.user.id, fixture.workerId);
  pass('Vercel browser login, secure host-only cookie, reload and full browser restart');

  await open(report.id);
  await page.getByLabel('Outcome', { exact: true }).nth(0).selectOption('pass');
  await page.getByLabel('Notes', { exact: true }).first().fill('Recorded pressure: 2.1 bar.');
  await page.getByLabel('Outcome', { exact: true }).nth(1).selectOption('pass');
  await page.getByLabel('Report summary', { exact: true }).fill('Demo checks: pressure recorded, no visible leaks.');
  await empty(report.id);
  const before = await detail(report.id), ai = page.getByRole('region', { name: 'AI assistance', exact: true });
  await wait(async () => !(await ai.getByRole('button', { name: 'Draft report', exact: true }).isDisabled()), 'AI request readiness');
  await ai.getByRole('button', { name: 'Draft report', exact: true }).click();
  const artifact = await wait(async () => {
    const list = await api(context.request, 'GET', `/inspections/${report.id}/ai`);
    return list.artifacts.find(row => row.sourceVersion === before.version && row.status === 'ready');
  }, 'hosted Groq report', 90000);
  assert.equal(artifact.provider, 'groq'); assert.equal(artifact.mode, 'provider'); assert.equal(artifact.fallbackReason, null);
  assert.equal(artifact.model, 'openai/gpt-oss-20b'); assert.ok(artifact.providerRequestId); assert.ok(artifact.original.text.trim());
  assert.equal((await detail(report.id)).version, before.version);
  await ai.getByRole('button', { name: 'Review suggestion', exact: true }).first().click();
  const reviewed = 'Reviewed demo report: recorded pump pressure 2.1 bar; leak check passed.';
  await ai.getByLabel('Reviewed report summary', { exact: true }).fill(reviewed);
  assert.equal(await ai.getByRole('button', { name: 'Apply reviewed edits', exact: true }).isDisabled(), true);
  await ai.getByRole('checkbox', { name: 'I checked this draft against the inspection and accept these edits.' }).check();
  await ai.getByRole('button', { name: 'Apply reviewed edits', exact: true }).click();
  await wait(async () => (await detail(report.id)).reportText === reviewed, 'reviewed report application');
  const applied = await detail(report.id); assert.equal(applied.version, before.version + 1);
  assert.ok(applied.aiSources.some(row => row.artifactId === artifact.id && row.provider === 'groq'));
  pass('Hosted Groq generation, explicit review, applied report and saved provenance', { model: artifact.model });
  await page.screenshot({ path: resolve(local, 'groq-report-desktop.png'), fullPage: true });

  await attach('acceptance-photo.png', 'image/png', png);
  await evidenceCount(report.id, 1);
  await attach('acceptance-audio.wav', 'audio/wav', wav);
  await evidenceCount(report.id, 2);
  await wait(async () => (await api(context.request, 'GET', `/inspections/${report.id}/evidence`)).evidence.filter(file => file.processingStatus === 'ready').length === 2,
    'Cloudinary byte verification', 90000);
  const files = (await detail(report.id)).evidence;
  for (const file of files) await checkDownload(report.id, file);
  assert.deepEqual([...uploadOrigins], [origin]);
  pass('Real Cloudinary PNG/audio upload, worker verification and original-byte download');
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Remove evidence', exact: true }).first().click();
  await wait(async () => (await detail(report.id)).evidence.length === 1, 'photo removal');
  await api(context.request, 'GET', `/inspections/${report.id}/evidence/${files[0].id}/download`, undefined, 404);
  pass('Evidence removal and denied removed-file download');

  await open(offline.id);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await context.setOffline(true);
  await page.getByLabel('Report summary', { exact: true }).fill('Offline acceptance notes retained after reload.');
  await attach('acceptance-offline-photo.png', 'image/png', png);
  await page.getByText('Stored on this device; upload queued', { exact: true }).waitFor();
  await page.reload(); await page.getByRole('heading', { name: 'Complete checklist', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Report summary', { exact: true }).inputValue(), 'Offline acceptance notes retained after reload.');
  const state = await deviceState(); assert.ok(state.blobs.some(row => row.size === png.length));
  await context.setOffline(false);
  await wait(async () => { const row = await detail(offline.id); return row.reportText === 'Offline acceptance notes retained after reload.' && row.evidence.length === 1; }, 'offline replay', 90000);
  await empty(offline.id); await checkDownload(offline.id, (await detail(offline.id)).evidence[0]);
  pass('Production offline note/file persistence, offline reload and reconnect replay');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: resolve(local, 'offline-mobile.png'), fullPage: true });
  const unsafeCaches = await page.evaluate(async () => { const urls = []; for (const name of await caches.keys()) for (const req of await (await caches.open(name)).keys()) if (new URL(req.url).pathname.startsWith('/api/')) urls.push(req.url); return urls; });
  assert.deepEqual(unsafeCaches, []); pass('Mobile overflow and exclusion of private API responses from shell caches');

  otherAPI = await request.newContext({ baseURL: origin, extraHTTPHeaders: { Origin: origin } });
  if (!fixture.otherOrganizationId) {
    fixture.otherOrganizationId = (await api(otherAPI, 'POST', '/auth/register-org', { organizationName: `Other acceptance ${fixture.tag}`,
      name: 'Other acceptance admin', email: fixture.otherEmail, password: fixture.password }, 201)).organization.id;
    await persist();
  } else await api(otherAPI, 'POST', '/auth/login', { organizationId: fixture.otherOrganizationId, email: fixture.otherEmail, password: fixture.password });
  await api(otherAPI, 'GET', `/inspections/${report.id}`, undefined, 404);
  await api(otherAPI, 'GET', `/inspections/${report.id}/ai`, undefined, 404);
  await api(otherAPI, 'GET', `/inspections/${report.id}/evidence/${files[1].id}/download`, undefined, 404);
  pass('Cross-tenant inspection, AI artifact and evidence access denied');
  await page.getByRole('button', { name: 'Log out', exact: true }).click(); await page.waitForURL(`${origin}/login`);
  await wait(async () => (await browserIdentity()).status === 401, 'server logout acknowledgement');
  await wait(async () => !(await context.cookies(origin)).some(row => row.name === 'fieldsync_sid'), 'session cookie removal');
  pass('Browser logout clears and revokes the proxied session');
  assert.deepEqual(errors, []); pass('No browser page errors');
  results.completedAt = new Date().toISOString(); results.status = 'passed';
} catch (error) {
  results.status = 'failed'; results.error = error.message.replaceAll(fixture?.password ?? 'unused-secret-marker', '[redacted]');
  if (page && !page.isClosed()) await page.screenshot({ path: resolve(local, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(results.error); process.exitCode = 1;
} finally {
  await writeFile(resultFile, JSON.stringify(results, null, 2));
  await context?.close(); await adminAPI?.dispose(); await otherAPI?.dispose();
}
