import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import request from 'supertest';
import { inspectionSchema, inspectionDetailSchema, templateDetailSchema, templatesResponseSchema, inspectionsResponseSchema } from '@fieldsync/contracts';
import { env } from '../apps/server/src/config/env.js';
import { createPool } from '../apps/server/src/infrastructure/database.js';
import { runMigrations } from '../apps/server/src/infrastructure/migrations.js';
import { createLogger } from '../apps/server/src/infrastructure/logger.js';
import { createHealthCheck } from '../apps/server/src/modules/health/service.js';
import { createApp } from '../apps/server/src/app.js';

const schema = `fieldsync_m2_${randomUUID().replaceAll('-', '')}`;
const origin = new URL(env.APP_ORIGIN).origin;
const password = 'Integration-test-password-27';
const quiet = { info() {}, warn() {}, error() {}, debug() {}, log() {} };
let adminPool, pool, server, orgA, orgB, workerA, workerA2, workerB;
const intent = (body = {}) => ({ ...body, mutationId: randomUUID() });
function send(method, path, owner, body) {
  let req = request(server)[method](`/api/v1${path}`).set('Origin', origin);
  if (owner) req = req.set('Cookie', owner.cookie);
  return body === undefined ? req : req.send(body);
}
async function register(name) {
  const res = await send('post', '/auth/register-org', null, { organizationName: name, name, email: 'admin@example.test', password }).expect(201);
  return { ...res.body, cookie: res.headers['set-cookie'][0].split(';')[0] };
}
async function worker(owner, email) {
  const created = await send('post', '/users', owner, { name: email, email, password }).expect(201);
  const login = await send('post', '/auth/login', null, { organizationId: owner.organization.id, email, password }).expect(200);
  return { user: created.body, cookie: login.headers['set-cookie'][0].split(';')[0] };
}
async function template(owner = orgA) {
  return (await send('post', '/templates', owner, intent({ name: ' Pump check ', description: ' Check equipment ',
    items: [{ id: randomUUID(), label: ' Check pressure ' }, { id: randomUUID(), label: 'Check seals' }] })).expect(201)).body;
}
async function fresh(owner = orgA, assigned = workerA) {
  const asset = (await send('post', '/assets', owner, { code: randomUUID(), name: 'Pump', category: 'Equipment', location: 'Yard' }).expect(201)).body;
  const form = await template(owner);
  const input = intent({ assetId: asset.id, templateId: form.id, assignedTo: assigned.user.id });
  const inspection = inspectionSchema.parse((await send('post', '/inspections', owner, input).expect(201)).body);
  return { inspection, asset, form, input };
}
const content = (inspection, extra = {}) => intent({ baseVersion: inspection.version, reportText: 'Inspection completed manually.',
  answers: inspection.template.items.map((item) => ({ itemId: item.id, outcome: 'pass', notes: '' })), ...extra });
async function detail(inspection, owner = orgA) {
  return inspectionDetailSchema.parse((await send('get', `/inspections/${inspection.id}`, owner).expect(200)).body);
}

before(async () => {
  adminPool = createPool(env);
  assert.match(schema, /^fieldsync_m2_[a-f0-9]{32}$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  pool = createPool(env, { schema });
  await runMigrations(pool, quiet, schema);
  const logger = createLogger('silent');
  server = createServer(createApp({ pool, env, logger, getHealth: createHealthCheck({ pool, env, logger }) }));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  orgA = await register('M2 A'); orgB = await register('M2 B');
  workerA = await worker(orgA, 'worker-a@example.test');
  workerA2 = await worker(orgA, 'worker-a2@example.test');
  workerB = await worker(orgB, 'worker-b@example.test');
});
after(async () => {
  try {
    if (server?.listening) await new Promise((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); });
  } finally {
    try { if (pool) await pool.end(); }
    finally {
      if (adminPool) {
        try { assert.match(schema, /^fieldsync_m2_[a-f0-9]{32}$/); await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
        finally { await adminPool.end(); }
      }
    }
  }
});

test('admins create and version templates with audit history; workers cannot manage templates', async () => {
  const form = await template();
  assert.equal(form.name, 'Pump check'); assert.equal(form.items[0].label, 'Check pressure');
  const update = intent({ name: 'Revised check', description: form.description, items: form.items, status: 'archived', baseVersion: 1 });
  const saved = (await send('patch', `/templates/${form.id}`, orgA, update).expect(200)).body;
  assert.equal(saved.version, 2);
  const history = templateDetailSchema.parse((await send('get', `/templates/${form.id}`, orgA).expect(200)).body);
  assert.deepEqual(history.events.map((event) => event.eventType), ['created', 'updated']);
  assert.deepEqual(history.events[1].details.changes.name, { before: 'Pump check', after: 'Revised check' });
  assert.ok(history.events.every((event) => event.actorUserId === orgA.user.id));
  assert.ok(!(await send('get', '/templates', orgA)).body.templates.some((entry) => entry.id === form.id));
  assert.ok((await send('get', '/templates?status=archived', orgA)).body.templates.some((entry) => entry.id === form.id));
  await send('get', '/templates', workerA).expect(403);
  await send('post', '/templates', workerA, intent({ name: 'Bad', description: '', items: form.items })).expect(403);
  await send('patch', `/templates/${form.id}`, workerA, update).expect(403);
});

test('assignment freezes template and asset snapshots even after template edits and archival', async () => {
  const { inspection, asset, form } = await fresh();
  await send('patch', `/templates/${form.id}`, orgA, intent({ name: 'New template', description: '',
    items: [{ id: randomUUID(), label: 'New question' }], status: 'archived', baseVersion: form.version })).expect(200);
  await send('patch', `/assets/${asset.id}`, orgA, { name: 'Renamed pump', status: 'archived', baseVersion: asset.version }).expect(200);
  const current = (await detail(inspection)).inspection;
  assert.deepEqual(current.template, inspection.template); assert.equal(current.asset.name, 'Pump');
  const submitted = await send('post', `/inspections/${inspection.id}/submit`, workerA, content(inspection)).expect(200);
  assert.equal(submitted.body.status, 'submitted');
  const archivedTemplate = await send('post', '/inspections', orgA, intent({ assetId: asset.id, templateId: form.id, assignedTo: workerA.user.id })).expect(400);
  assert.equal(archivedTemplate.body.error.code, 'TEMPLATE_ARCHIVED');
  const activeTemplate = await template();
  const archivedAsset = await send('post', '/inspections', orgA, intent({ assetId: asset.id, templateId: activeTemplate.id, assignedTo: workerA.user.id })).expect(400);
  assert.equal(archivedAsset.body.error.code, 'ASSET_ARCHIVED');
});

test('tenant scoping covers templates, assignments, inspection lists, IDs and injected ownership', async () => {
  const a = await fresh(); const b = await fresh(orgB, workerB);
  const templatesA = templatesResponseSchema.parse((await send('get', '/templates?status=all', orgA)).body).templates;
  assert.ok(templatesA.every((entry) => entry.organizationId === orgA.organization.id));
  await send('get', `/templates/${b.form.id}`, orgA).expect(404);
  await send('patch', `/templates/${b.form.id}`, orgA, intent({ name: 'Bad', description: '', items: b.form.items, status: 'active', baseVersion: 1 })).expect(404);
  const inspectionsA = inspectionsResponseSchema.parse((await send('get', '/inspections', orgA)).body).inspections;
  assert.ok(inspectionsA.every((entry) => entry.organizationId === orgA.organization.id));
  assert.ok(!inspectionsA.some((entry) => entry.id === b.inspection.id));
  await send('get', `/inspections/${b.inspection.id}`, orgA).expect(404);
  await send('patch', `/inspections/${b.inspection.id}/assignment`, orgA, intent({ assignedTo: workerA.user.id, baseVersion: 1 })).expect(404);
  for (const extra of [{ templateId: b.form.id }, { assetId: b.asset.id }, { assignedTo: workerB.user.id }, { assignedTo: orgA.user.id }]) {
    await send('post', '/inspections', orgA, intent({ assetId: a.asset.id, templateId: a.form.id, assignedTo: workerA.user.id, ...extra })).expect(404);
  }
  await send('post', '/inspections', orgA, { ...a.input, mutationId: randomUUID(), organizationId: orgB.organization.id }).expect(400);
  await send('get', `/inspections?organizationId=${orgB.organization.id}`, orgA).expect(400);
  await send('get', `/templates?organizationId=${orgB.organization.id}`, orgA).expect(400);
});

test('only the assigned worker executes checklists; admins and other workers cannot edit content', async () => {
  const { inspection } = await fresh();
  await send('get', `/inspections/${inspection.id}`, workerA).expect(200);
  await send('get', `/inspections/${inspection.id}`, workerA2).expect(404);
  assert.ok(!(await send('get', '/inspections', workerA2)).body.inspections.some((entry) => entry.id === inspection.id));
  await send('patch', `/inspections/${inspection.id}`, workerA2, content(inspection)).expect(404);
  await send('patch', `/inspections/${inspection.id}`, orgA, content(inspection)).expect(403);
  await send('post', '/inspections', workerA, intent({ assetId: inspection.assetId, templateId: inspection.templateId, assignedTo: workerA.user.id })).expect(403);
  await send('post', `/inspections/${inspection.id}/review`, workerA, intent({ decision: 'approve', note: '', baseVersion: 1 })).expect(403);
});

test('strict request schemas reject forged workflow fields, bad versions and invalid checklist IDs', async () => {
  const { inspection, form } = await fresh();
  await send('patch', `/inspections/${inspection.id}`, workerA, content(inspection, { status: 'approved' })).expect(400);
  await send('patch', `/inspections/${inspection.id}`, workerA, content(inspection, { baseVersion: '1' })).expect(400);
  await send('patch', `/inspections/${inspection.id}`, workerA, content(inspection, { assignedTo: workerA2.user.id })).expect(400);
  await send('patch', `/inspections/${inspection.id}`, workerA, { ...content(inspection), mutationId: undefined }).expect(400);
  await send('patch', `/inspections/${inspection.id}`, workerA, content(inspection, { answers: [{ itemId: randomUUID(), outcome: 'pass', notes: '' }] })).expect(400);
  const repeated = { itemId: form.items[0].id, outcome: 'pass', notes: '' };
  await send('patch', `/inspections/${inspection.id}`, workerA, content(inspection, { answers: [repeated, repeated] })).expect(400);
  await send('post', '/templates', orgA, intent({ name: 'Bad', description: '', items: [form.items[0], form.items[0]] })).expect(400);
  await send('get', '/inspections/not-a-uuid', orgA).expect(400);
  await send('get', '/inspections?status=deleted', orgA).expect(400);
  await send('get', '/templates?status=deleted', orgA).expect(400);
  await request(server).post('/api/v1/inspections').set('Cookie', orgA.cookie).send({}).expect(403);
  await send('post', '/inspections', orgA).type('form').send({}).expect(415);
  await send('post', '/templates', orgA, { description: 'x'.repeat(140000) }).expect(413);
  assert.equal((await detail(inspection)).inspection.version, 1);
});

test('drafts allow incomplete answers; submission requires all outcomes and notes on failures', async () => {
  const { inspection } = await fresh();
  let current = (await send('patch', `/inspections/${inspection.id}`, workerA, content(inspection, { answers: [] })).expect(200)).body;
  assert.equal(current.status, 'draft'); assert.ok(current.answers.every((answer) => answer.outcome === null));
  await send('post', `/inspections/${inspection.id}/submit`, workerA, content(current, { answers: current.answers })).expect(400);
  const fail = content(current); fail.answers[0].outcome = 'fail';
  await send('post', `/inspections/${inspection.id}/submit`, workerA, fail).expect(400);
  fail.answers[0].notes = ' Leaking seal '; fail.answers[1].outcome = 'not_applicable'; fail.mutationId = randomUUID();
  current = (await send('post', `/inspections/${inspection.id}/submit`, workerA, fail).expect(200)).body;
  assert.equal(current.answers[0].notes, 'Leaking seal'); assert.equal(current.status, 'submitted');
  assert.equal((await detail(inspection)).revisions.length, 3);
});

test('report review requests changes, resubmits, approves and preserves all historical revisions', async () => {
  const { inspection } = await fresh();
  let current = (await send('patch', `/inspections/${inspection.id}`, workerA, content(inspection, { reportText: 'Original narrative' })).expect(200)).body;
  const submitBody = content(current, { reportText: current.reportText });
  current = (await send('post', `/inspections/${inspection.id}/submit`, workerA, submitBody).expect(200)).body;
  await send('post', `/inspections/${inspection.id}/review`, orgA, intent({ decision: 'request_changes', note: ' ', baseVersion: current.version })).expect(400);
  current = (await send('post', `/inspections/${inspection.id}/review`, orgA, intent({ decision: 'request_changes', note: 'Explain the repair.', baseVersion: current.version })).expect(200)).body;
  assert.equal(current.reviewNote, 'Explain the repair.');
  current = (await send('patch', `/inspections/${inspection.id}`, workerA, content(current, { reportText: 'Repaired and rechecked.' })).expect(200)).body;
  current = (await send('post', `/inspections/${inspection.id}/submit`, workerA, content(current, { reportText: current.reportText })).expect(200)).body;
  current = (await send('post', `/inspections/${inspection.id}/review`, orgA, intent({ decision: 'approve', note: 'Reviewed.', baseVersion: current.version })).expect(200)).body;
  assert.equal(current.status, 'approved'); assert.equal(current.approvedBy, orgA.user.id); assert.ok(current.approvedAt);
  const historical = await detail(inspection);
  assert.deepEqual(historical.events.map((event) => event.eventType), ['created', 'saved', 'submitted', 'changes_requested', 'saved', 'submitted', 'approved']);
  assert.deepEqual(historical.revisions.map((entry) => entry.version), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(historical.revisions[1].snapshot.reportText, 'Original narrative');
  assert.equal(historical.inspection.reportText, 'Repaired and rechecked.');
  for (const [method, path, body, owner] of [
    ['patch', '', content(current), workerA], ['post', '/submit', content(current), workerA],
    ['patch', '/assignment', intent({ assignedTo: workerA2.user.id, baseVersion: current.version }), orgA],
    ['post', '/cancel', intent({ note: '', baseVersion: current.version }), orgA],
    ['post', '/review', intent({ decision: 'request_changes', note: 'Again', baseVersion: current.version }), orgA],
  ]) await send(method, `/inspections/${inspection.id}${path}`, owner, body).expect(409);
  // Receipt replay precedes workflow checks, but still uses current access checks.
  const replay = await send('post', `/inspections/${inspection.id}/submit`, workerA, submitBody).expect(200);
  assert.equal(replay.body.version, 3);
  assert.deepEqual(await detail(inspection), historical);
});

test('concurrent inspection updates use row locks and reject the losing base version', async () => {
  const { inspection } = await fresh();
  const bodies = [content(inspection, { reportText: 'First' }), content(inspection, { reportText: 'Second' })];
  const results = await Promise.all(bodies.map((body) => send('patch', `/inspections/${inspection.id}`, workerA, body)));
  assert.deepEqual(results.map((res) => res.status).sort(), [200, 409]);
  assert.equal(results.find((res) => res.status === 409).body.error.code, 'VERSION_CONFLICT');
  const current = await detail(inspection);
  assert.equal(current.inspection.version, 2); assert.equal(current.events.length, 2); assert.equal(current.revisions.length, 2);
  const loser = bodies[results.findIndex((res) => res.status === 409)];
  const rejectedReplay = await send('patch', `/inspections/${inspection.id}`, workerA, loser).expect(409);
  assert.equal(rejectedReplay.body.error.code, 'VERSION_CONFLICT');
});

test('concurrent receipt replays return the stored result once and reject changed content', async () => {
  const { inspection, input } = await fresh();
  assert.deepEqual((await send('post', '/inspections', orgA, input).expect(201)).body, inspection);
  const body = content(inspection);
  const results = await Promise.all([send('patch', `/inspections/${inspection.id}`, workerA, body), send('patch', `/inspections/${inspection.id}`, workerA, body)]);
  assert.ok(results.every((res) => res.status === 200)); assert.deepEqual(results[0].body, results[1].body);
  const changed = await send('patch', `/inspections/${inspection.id}`, workerA, { ...body, reportText: 'Different' }).expect(409);
  assert.equal(changed.body.error.code, 'MUTATION_ID_REUSED');
  assert.equal((await detail(inspection)).revisions.length, 2);
});

test('reassignment retains saved work and revokes the previous worker access, including replays', async () => {
  const { inspection } = await fresh();
  const body = content(inspection);
  let current = (await send('patch', `/inspections/${inspection.id}`, workerA, body).expect(200)).body;
  await send('patch', `/inspections/${inspection.id}/assignment`, orgA, intent({ assignedTo: workerB.user.id, baseVersion: current.version })).expect(404);
  current = (await send('patch', `/inspections/${inspection.id}/assignment`, orgA, intent({ assignedTo: workerA2.user.id, baseVersion: current.version })).expect(200)).body;
  assert.deepEqual(current.answers, inspection.template.items.map((item) => ({ itemId: item.id, outcome: 'pass', notes: '' })));
  await send('get', `/inspections/${inspection.id}`, workerA).expect(404);
  await send('patch', `/inspections/${inspection.id}`, workerA, body).expect(404);
  await send('get', `/inspections/${inspection.id}`, workerA2).expect(200);
  current = (await send('post', `/inspections/${inspection.id}/cancel`, orgA, intent({ note: 'No longer needed', baseVersion: current.version })).expect(200)).body;
  await send('patch', `/inspections/${inspection.id}`, workerA2, content(current)).expect(409);
  assert.equal((await detail(inspection)).inspection.status, 'cancelled');
});

test('mutation receipt keys are scoped to organization and actor', async () => {
  const body = intent({ name: 'Shared mutation ID', description: '', items: [{ id: randomUUID(), label: 'Check' }] });
  const a = (await send('post', '/templates', orgA, body).expect(201)).body;
  const b = (await send('post', '/templates', orgB, body).expect(201)).body;
  assert.notEqual(a.id, b.id);
  assert.equal(a.organizationId, orgA.organization.id); assert.equal(b.organizationId, orgB.organization.id);
  assert.equal((await pool.query('SELECT * FROM mutation_receipts WHERE mutation_id = $1', [body.mutationId])).rowCount, 2);
});

test('review and reassignment cannot bypass submission state or stale versions', async () => {
  const { inspection } = await fresh();
  await send('post', `/inspections/${inspection.id}/review`, orgA, intent({ decision: 'approve', note: '', baseVersion: 1 })).expect(409);
  const submitted = (await send('post', `/inspections/${inspection.id}/submit`, workerA, content(inspection)).expect(200)).body;
  await send('patch', `/inspections/${inspection.id}/assignment`, orgA, intent({ assignedTo: workerA2.user.id, baseVersion: submitted.version })).expect(409);
  await send('post', `/inspections/${inspection.id}/review`, orgA, intent({ decision: 'approve', note: '', baseVersion: 1 })).expect(409);
  const attempts = await Promise.all(['approve', 'request_changes'].map((decision) => send('post', `/inspections/${inspection.id}/review`, orgA,
    intent({ decision, note: 'Reviewed', baseVersion: submitted.version }))));
  assert.deepEqual(attempts.map((res) => res.status).sort(), [200, 409]);
  assert.equal((await detail(inspection)).events.length, 3);
});

test('composite foreign keys reject cross-tenant M2 references and audit actors', async () => {
  const a = await fresh(); const b = await fresh(orgB, workerB);
  const rejects = (sql, values) => assert.rejects(pool.query(sql, values), { code: '23503' });
  await rejects('INSERT INTO inspection_templates (id, organization_id, name, items, created_by) VALUES ($1, $2, $3, $4::jsonb, $5)',
    [randomUUID(), orgA.organization.id, 'Bad', JSON.stringify(a.form.items), orgB.user.id]);
  for (const [column, foreignId] of [['asset_id', b.asset.id], ['template_id', b.form.id], ['assigned_to', workerB.user.id], ['created_by', orgB.user.id]]) {
    const columns = ['asset_id', 'template_id', 'assigned_to', 'created_by'];
    const selection = columns.map((field) => field === column ? '$4::uuid' : field);
    await rejects(`INSERT INTO inspections (id, organization_id, asset_id, template_id, assigned_to, created_by, asset_snapshot, template_snapshot, worker_snapshot)
      SELECT $1, organization_id, ${selection.join(', ')}, asset_snapshot, template_snapshot, worker_snapshot
      FROM inspections WHERE organization_id = $2 AND id = $3`, [randomUUID(), orgA.organization.id, a.inspection.id, foreignId]);
  }
  await rejects(`UPDATE inspections SET status = 'approved', approved_at = now(), approved_by = $3 WHERE organization_id = $1 AND id = $2`,
    [orgA.organization.id, a.inspection.id, orgB.user.id]);
  for (const [table, key, localId, foreignId] of [['template_events', 'template_id', a.form.id, b.form.id], ['inspection_events', 'inspection_id', a.inspection.id, b.inspection.id]]) {
    for (const [resourceId, actorId] of [[foreignId, orgA.user.id], [localId, orgB.user.id]]) {
      await rejects(`INSERT INTO ${table} (id, organization_id, ${key}, actor_user_id, event_type, version, details) VALUES ($1, $2, $3, $4, 'created', 1, '{}'::jsonb)`,
        [randomUUID(), orgA.organization.id, resourceId, actorId]);
    }
  }
  for (const [inspectionId, actorId] of [[b.inspection.id, orgA.user.id], [a.inspection.id, orgB.user.id]]) {
    await rejects('INSERT INTO inspection_revisions (id, organization_id, inspection_id, version, snapshot, created_by) VALUES ($1, $2, $3, 99, $4::jsonb, $5)',
      [randomUUID(), orgA.organization.id, inspectionId, JSON.stringify(a.inspection), actorId]);
  }
  for (const [userId, templateId, inspectionId] of [[orgB.user.id, null, null], [orgA.user.id, b.form.id, null], [orgA.user.id, null, b.inspection.id]]) {
    await rejects(`INSERT INTO mutation_receipts (organization_id, user_id, mutation_id, request_hash, outcome, template_id, inspection_id)
      VALUES ($1, $2, $3, 'hash', '{}'::jsonb, $4, $5)`, [orgA.organization.id, userId, randomUUID(), templateId, inspectionId]);
  }
});

test('template updates are optimistic and their audit writes are atomic', async () => {
  const form = await template();
  const bodies = ['One', 'Two'].map((name) => intent({ name, description: form.description, items: form.items, status: 'active', baseVersion: 1 }));
  const results = await Promise.all(bodies.map((body) => send('patch', `/templates/${form.id}`, orgA, body)));
  assert.deepEqual(results.map((res) => res.status).sort(), [200, 409]);
  const current = (await send('get', `/templates/${form.id}`, orgA)).body;
  assert.equal(current.events.length, 2);
  await pool.query(`CREATE FUNCTION reject_m2_template_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Deliberate test failure'; END $$`);
  await pool.query('CREATE TRIGGER reject_m2_template_audit BEFORE INSERT ON template_events FOR EACH ROW EXECUTE FUNCTION reject_m2_template_audit()');
  const body = intent({ name: 'Rollback', description: '', items: form.items, status: 'active', baseVersion: current.template.version });
  try {
    await send('patch', `/templates/${form.id}`, orgA, body).expect(500);
    assert.deepEqual((await send('get', `/templates/${form.id}`, orgA)).body, current);
    assert.equal((await pool.query('SELECT * FROM mutation_receipts WHERE organization_id = $1 AND user_id = $2 AND mutation_id = $3',
      [orgA.organization.id, orgA.user.id, body.mutationId])).rowCount, 0);
  } finally {
    await pool.query('DROP TRIGGER reject_m2_template_audit ON template_events'); await pool.query('DROP FUNCTION reject_m2_template_audit()');
  }
});

test('audit, revision and receipt failures roll back inspection writes and allow safe retry', async () => {
  for (const table of ['inspection_events', 'inspection_revisions', 'mutation_receipts']) {
    const { inspection } = await fresh();
    const before = await detail(inspection);
    const body = content(inspection);
    await pool.query(`CREATE FUNCTION reject_m2_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Deliberate test failure'; END $$`);
    await pool.query(`CREATE TRIGGER reject_m2_write BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_m2_write()`);
    try {
      await send('patch', `/inspections/${inspection.id}`, workerA, body).expect(500);
      assert.deepEqual(await detail(inspection), before);
      assert.equal((await pool.query('SELECT * FROM mutation_receipts WHERE organization_id = $1 AND user_id = $2 AND mutation_id = $3',
        [orgA.organization.id, workerA.user.id, body.mutationId])).rowCount, 0);
    } finally {
      await pool.query(`DROP TRIGGER reject_m2_write ON ${table}`); await pool.query('DROP FUNCTION reject_m2_write()');
    }
    await send('patch', `/inspections/${inspection.id}`, workerA, body).expect(200);
    assert.equal((await detail(inspection)).events.length, 2);
  }
});

test('failed inspection creation leaves no aggregate, revision, audit or receipt', async () => {
  const { asset, form } = await fresh();
  const body = intent({ assetId: asset.id, templateId: form.id, assignedTo: workerA.user.id });
  const before = (await pool.query('SELECT count(*)::int AS count FROM inspections WHERE organization_id = $1', [orgA.organization.id])).rows[0].count;
  await pool.query(`CREATE FUNCTION reject_m2_create() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Deliberate test failure'; END $$`);
  await pool.query('CREATE TRIGGER reject_m2_create BEFORE INSERT ON inspection_events FOR EACH ROW EXECUTE FUNCTION reject_m2_create()');
  try {
    await send('post', '/inspections', orgA, body).expect(500);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM inspections WHERE organization_id = $1', [orgA.organization.id])).rows[0].count, before);
    assert.equal((await pool.query('SELECT * FROM mutation_receipts WHERE organization_id = $1 AND user_id = $2 AND mutation_id = $3',
      [orgA.organization.id, orgA.user.id, body.mutationId])).rowCount, 0);
  } finally {
    await pool.query('DROP TRIGGER reject_m2_create ON inspection_events'); await pool.query('DROP FUNCTION reject_m2_create()');
  }
  await send('post', '/inspections', orgA, body).expect(201);
});

test('migration reruns are safe and expired sessions cannot replay successful mutations', async () => {
  assert.equal((await runMigrations(pool, quiet, schema)).length, 0);
  const owner = await register('Expired M2'); const assigned = await worker(owner, 'expiry@example.test');
  const { inspection } = await fresh(owner, assigned); const body = content(inspection);
  await send('patch', `/inspections/${inspection.id}`, assigned, body).expect(200);
  await pool.query(`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE organization_id = $1 AND user_id = $2`, [owner.organization.id, assigned.user.id]);
  await send('patch', `/inspections/${inspection.id}`, assigned, body).expect(401);
});
