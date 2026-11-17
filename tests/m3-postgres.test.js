import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import supertest from 'supertest';
import { env } from '../apps/server/src/config/env.js';
import { createPool } from '../apps/server/src/infrastructure/database.js';
import { runMigrations } from '../apps/server/src/infrastructure/migrations.js';
import { createApp } from '../apps/server/src/app.js';
import { createLogger } from '../apps/server/src/infrastructure/logger.js';
import { flushOutbox } from '../apps/web/src/offline/sync.js';
import { contentOf, mergeContent } from '../apps/web/src/offline/state.js';
import { MemoryStore, apiError } from './helpers/offline.js';

const schema = `fieldsync_m3_${randomUUID().replaceAll('-', '')}`;
const adminPool = createPool(env), pool = createPool(env, { schema });
const origin = 'http://127.0.0.1:5173';
const password = 'M3-integration-password-27';
let api, admin, worker, workspace, asset, template;
const cookie = (response) => response.headers['set-cookie'][0].split(';')[0];
function send(method, path, actor, body) {
  let request = api[method](`/api/v1${path}`).set('Origin', origin);
  if (actor) request = request.set('Cookie', actor);
  return body ? request.send(body) : request;
}
before(async () => {
  assert.match(schema, /^fieldsync_m3_[a-f0-9]{32}$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  await runMigrations(pool, { info() {}, warn() {}, error() {} }, schema);
  api = supertest(createApp({ pool, env: { ...env, APP_ORIGIN: origin }, logger: createLogger('silent'), getHealth: async () => ({}) }));
  const registered = await send('post', '/auth/register-org', null, { organizationName: 'M3 Tests', name: 'Admin', email: 'admin@example.test', password }).expect(201);
  admin = cookie(registered);
  const user = (await send('post', '/users', admin, { name: 'Worker', email: 'worker@example.test', password }).expect(201)).body;
  workspace = { organizationId: registered.body.organization.id, userId: user.id };
  worker = cookie(await send('post', '/auth/login', null, { organizationId: workspace.organizationId, email: 'worker@example.test', password }).expect(200));
  asset = (await send('post', '/assets', admin, { code: 'M3-PUMP', name: 'Pump', category: 'Pumps', location: 'Yard' }).expect(201)).body;
  template = (await send('post', '/templates', admin, { name: 'Safety', description: '', items: [{ id: randomUUID(), label: 'Pressure' }], mutationId: randomUUID() }).expect(201)).body;
});
after(async () => {
  await pool.end();
  try { assert.match(schema, /^fieldsync_m3_[a-f0-9]{32}$/); await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
  finally { await adminPool.end(); }
});
async function assigned() {
  return (await send('post', '/inspections', admin, { assetId: asset.id, templateId: template.id, assignedTo: workspace.userId, mutationId: randomUUID() }).expect(201)).body;
}
function transport(actor = worker) {
  return async (path, options) => {
    const response = await send((options.method ?? 'GET').toLowerCase(), path, actor, options.body);
    if (!response.ok) throw apiError(response.status, response.body.error.code);
    return options.schema.parse(response.body);
  };
}
function complete(row, text) { return { ...contentOf(row), reportText: text, answers: row.template.items.map((item) => ({ itemId: item.id, outcome: 'pass', notes: '' })) }; }

test('M3 PostgreSQL save/submit replay after a lost response applies each receipt, version and audit once', async () => {
  const row = await assigned(), store = new MemoryStore([row], workspace), request = transport();
  store.save(row.id, complete(row, 'Saved offline')); store.save(row.id, complete(row, 'Submitted offline'), 'submit');
  let first = true; const sent = [];
  const unreliable = async (path, options) => {
    const response = await request(path, options);
    if (options.method) {
      sent.push(structuredClone(options.body));
      if (first) { first = false; throw new TypeError('Response lost after commit'); }
    }
    return response;
  };
  await assert.rejects(flushOutbox({ store, request: unreliable }), /after commit/);
  assert.equal(store.queue[0].status, 'attempted');
  await flushOutbox({ store, request: unreliable });
  assert.deepEqual(sent[0], sent[1]); assert.equal(sent[2].baseVersion, 2); assert.equal(store.queue.length, 0);
  const detail = (await send('get', `/inspections/${row.id}`, worker).expect(200)).body;
  assert.equal(detail.inspection.version, 3); assert.equal(detail.inspection.status, 'submitted');
  assert.deepEqual(detail.events.map((event) => event.eventType), ['created', 'saved', 'submitted']);
  assert.equal(detail.revisions.length, 3);
  const receipt = await pool.query('SELECT count(*)::int AS count FROM mutation_receipts WHERE organization_id = $1 AND user_id = $2', [workspace.organizationId, workspace.userId]);
  assert.equal(receipt.rows[0].count, 2);
});

test('M3 PostgreSQL conflict retains local content and submits an explicit merge with a new receipt', async () => {
  const row = await assigned(), store = new MemoryStore([row], workspace);
  store.save(row.id, complete(row, 'Offline summary')); store.save(row.id, complete(row, 'Offline summary'), 'submit');
  const remoteBody = { ...complete(row, 'Remote summary'), baseVersion: row.version, mutationId: randomUUID() };
  const remote = (await send('patch', `/inspections/${row.id}`, worker, remoteBody).expect(200)).body;
  const oldId = store.queue[0].mutationId;
  await flushOutbox({ store, request: transport() });
  const copy = store.copies.get(row.id);
  assert.equal(store.queue[0].status, 'conflict'); assert.equal(copy.content.reportText, 'Offline summary');
  const merge = mergeContent(copy.conflict.base, copy.content, copy.conflict.remote, { reportText: 'local' });
  assert.equal(merge.complete, true);
  store.resolve(row.id, remote, merge.content, 'submit', copy.generation);
  assert.notEqual(store.queue[0].mutationId, oldId); assert.equal(store.queue[0].body.baseVersion, remote.version);
  await flushOutbox({ store, request: transport() });
  const detail = (await send('get', `/inspections/${row.id}`, worker).expect(200)).body;
  assert.equal(detail.inspection.reportText, 'Offline summary'); assert.equal(detail.inspection.version, 3);
  assert.equal(detail.inspection.status, 'submitted'); assert.equal(store.queue.length, 0);
});

test('M3 PostgreSQL cancellation and expired access retain the queued working copy', async () => {
  const row = await assigned(), store = new MemoryStore([row], workspace);
  store.save(row.id, complete(row, 'Keep this work'));
  await send('post', `/inspections/${row.id}/cancel`, admin, { baseVersion: row.version, mutationId: randomUUID(), note: 'Closed remotely' }).expect(200);
  await flushOutbox({ store, request: transport() });
  assert.equal(store.queue[0].status, 'blocked'); assert.equal(store.copies.get(row.id).content.reportText, 'Keep this work');
  let expired = false;
  await flushOutbox({ store, request: transport('fieldsync_sid=invalid'), onExpired: () => { expired = true; } });
  assert.equal(expired, true); assert.equal(store.queue.length, 1);
});
