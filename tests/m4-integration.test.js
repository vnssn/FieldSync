import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import supertest from 'supertest';
import { Queue } from 'bullmq';
import { HeadObjectCommand, PutObjectCommand, DeleteBucketCommand } from '@aws-sdk/client-s3';
import { evidenceSchema, inspectionSchema, uploadResponseSchema, localEvidenceSchema, outboxEntrySchema } from '@fieldsync/contracts';
import { env } from '../apps/server/src/config/env.js';
import { createPool } from '../apps/server/src/infrastructure/database.js';
import { runMigrations } from '../apps/server/src/infrastructure/migrations.js';
import { createLogger } from '../apps/server/src/infrastructure/logger.js';
import { createEvidenceStorage, ensureBucket, evidencePrefix } from '../apps/server/src/infrastructure/storage.js';
import { createJobRuntime, processJob, recoverExpiredJobs, reconcileObjects } from '../apps/server/src/modules/jobs/worker.js';
import { createApp } from '../apps/server/src/app.js';
import { flushOutbox } from '../apps/web/src/offline/sync.js';
import { contentOf } from '../apps/web/src/offline/state.js';
import { uploadBlob } from '../apps/web/src/offline/evidence.js';
import { MemoryStore } from './helpers/offline.js';

// Every external resource is unique to this run. Never flush Redis, empty the
// development bucket, or drop a schema selected from user configuration.
const runId = randomUUID();
const schema = `fieldsync_m4_${runId.replaceAll('-', '')}`;
const bucket = `fieldsync-m4-${runId}`;
const settings = { ...env, S3_BUCKET: bucket, S3_PUBLIC_ENDPOINT: env.S3_ENDPOINT, QUEUE_PREFIX: schema };
const origin = new URL(env.APP_ORIGIN).origin;
const logger = createLogger('silent');
const password = 'M4-integration-password-27';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jKxkAAAAASUVORK5CYII=', 'base64');
let adminPool, pool, storage, server, orgA, orgB, workerA, workerA2, workerB;
const directories = new Map();
const intent = (body = {}) => ({ ...body, mutationId: randomUUID() });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function send(method, path, actor, body) {
  let req = supertest(server)[method](`/api/v1${path}`).set('Origin', origin);
  if (actor) req = req.set('Cookie', actor.cookie);
  return body === undefined ? req : req.send(body);
}
async function register(name) {
  const response = await send('post', '/auth/register-org', null, { organizationName: name, name, email: 'admin@example.test', password }).expect(201);
  return { ...response.body, cookie: response.headers['set-cookie'][0].split(';')[0] };
}
async function worker(owner, email) {
  const user = (await send('post', '/users', owner, { name: email, email, password }).expect(201)).body;
  const login = await send('post', '/auth/login', null, { organizationId: owner.organization.id, email, password }).expect(200);
  return { user, organization: owner.organization, cookie: login.headers['set-cookie'][0].split(';')[0] };
}
async function fresh(owner = orgA, actor = workerA) {
  const directory = directories.get(owner.organization.id);
  return inspectionSchema.parse((await send('post', '/inspections', owner, intent({
    assetId: directory.asset.id, templateId: directory.template.id, assignedTo: actor.user.id,
  })).expect(201)).body);
}
function content(row, text = 'Manual report with evidence') {
  return { reportText: text, answers: row.template.items.map((item) => ({ itemId: item.id, outcome: 'pass', notes: '' })) };
}
async function detail(row, actor = workerA) {
  return (await send('get', `/inspections/${row.id}`, actor).expect(200)).body;
}
async function reserve(row, { bytes = png, mimeType = 'image/png', name = 'field.png', actor = workerA, ...extra } = {}) {
  const body = intent({ evidenceId: randomUUID(), name, mimeType, size: bytes.length, sha256: hash(bytes), ...extra });
  const evidence = evidenceSchema.parse((await send('post', `/inspections/${row.id}/evidence/reserve`, actor, body).expect(201)).body);
  const descriptor = uploadResponseSchema.parse((await send('post', `/inspections/${row.id}/evidence/${evidence.id}/upload`, actor, {}).expect(200)).body);
  return { evidence, descriptor, bytes, body, row, actor };
}
function stagingKey(file) {
  return decodeURIComponent(new URL(file.descriptor.url).pathname).slice(`/${bucket}/`.length);
}
async function putFile(file, headers = {}, bytes = file.bytes, url = file.descriptor.url) {
  return fetch(url, { method: 'PUT', headers: { ...file.descriptor.headers, ...headers },
    body: new Blob([bytes], { type: file.body.mimeType }), signal: AbortSignal.timeout(10000) });
}
async function metadata(file) {
  return (await pool.query('SELECT * FROM evidence WHERE organization_id=$1 AND inspection_id=$2 AND id=$3',
    [file.row.organizationId, file.row.id, file.evidence.id])).rows[0];
}
async function objects(prefix) {
  const result = [];
  for await (const object of storage.objects(prefix)) result.push(object.Key);
  return result;
}
async function exists(key) {
  try { await storage.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })); return true; }
  catch (error) { if (error.$metadata?.httpStatusCode === 404) return false; throw error; }
}
async function jobFor(file, kind = 'verify_evidence') {
  return (await pool.query('SELECT * FROM background_jobs WHERE organization_id=$1 AND inspection_id=$2 AND evidence_id=$3 AND kind=$4 ORDER BY created_at DESC',
    [file.row.organizationId, file.row.id, file.evidence.id, kind])).rows[0];
}
async function runJob(job) { await processJob({ pool, storage }, { organizationId: job.organization_id, jobId: job.id }); }
async function attach(row, { ready = true, ...options } = {}) {
  const file = await reserve(row, options);
  assert.equal((await putFile(file)).status, 200);
  file.attachBody = intent({ evidenceId: file.evidence.id, baseVersion: row.version });
  file.inspection = (await send('post', `/inspections/${row.id}/evidence`, file.actor, file.attachBody).expect(200)).body;
  if (ready) await runJob(await jobFor(file));
  return file;
}
async function poll(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
const redisOptions = () => ({ host: env.REDIS_HOST, port: env.REDIS_PORT, password: env.REDIS_PASSWORD, maxRetriesPerRequest: 1 });
async function withRuntime(work) {
  const runtime = createJobRuntime({ pool, storage, env: settings, logger, intervalMs: 50 });
  try { await runtime.queue.waitUntilReady(); return await work(runtime); }
  finally { await runtime.close(); }
}

before(async () => {
  assert.match(schema, /^fieldsync_m4_[a-f0-9]{32}$/);
  assert.match(bucket, /^fieldsync-m4-[a-f0-9-]{36}$/);
  adminPool = createPool(env);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  pool = createPool(env, { schema });
  await runMigrations(pool, { info() {}, warn() {}, error() {} }, schema);
  storage = createEvidenceStorage(settings);
  await ensureBucket(storage.client, bucket, env.S3_REGION);
  server = createServer(createApp({ pool, env: settings, storage, logger, getHealth: async () => ({}) }));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  orgA = await register('M4 A'); orgB = await register('M4 B');
  workerA = await worker(orgA, 'worker-a@example.test');
  workerA2 = await worker(orgA, 'worker-a2@example.test');
  workerB = await worker(orgB, 'worker-b@example.test');
  for (const owner of [orgA, orgB]) {
    const asset = (await send('post', '/assets', owner, { code: randomUUID(), name: 'Pump', category: 'Equipment', location: 'Yard' }).expect(201)).body;
    const template = (await send('post', '/templates', owner, intent({ name: 'Safety', description: '', items: [{ id: randomUUID(), label: 'Pressure' }] })).expect(201)).body;
    directories.set(owner.organization.id, { asset, template });
  }
});
after(async () => {
  try {
    if (server?.listening) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    const queue = new Queue('fieldsync-jobs', { connection: redisOptions(), prefix: schema });
    try { await queue.obliterate({ force: true }); } finally { await queue.close(); }
    if (storage) {
      for await (const object of storage.objects()) await storage.remove(object.Key);
      await storage.client.send(new DeleteBucketCommand({ Bucket: bucket }));
    }
  } finally {
    storage?.client.destroy();
    if (pool) await pool.end();
    if (adminPool) {
      try { assert.match(schema, /^fieldsync_m4_[a-f0-9]{32}$/); await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await adminPool.end(); }
    }
  }
});

test('M4 composite FKs bind evidence and jobs to the organization, inspection and creator', async () => {
  const row = await fresh(), other = await fresh(), file = await reserve(row);
  const source = await metadata(file);
  async function invalidEvidence(organizationId, inspectionId, createdBy, keyOrganization = organizationId) {
    const id = randomUUID();
    return pool.query(`INSERT INTO evidence (id,organization_id,inspection_id,created_by,name,mime_type,size,sha256,staging_key,expires_at)
      VALUES ($1,$2,$3,$4,'test.png','image/png',$5,$6,$7,now()+interval '20 minutes')`,
    [id, organizationId, inspectionId, createdBy, png.length, hash(png), `${evidencePrefix(keyOrganization, inspectionId, id)}/staging/${randomUUID()}`]);
  }
  await assert.rejects(invalidEvidence(orgB.organization.id, row.id, workerB.user.id), { code: '23503' });
  await assert.rejects(invalidEvidence(row.organizationId, row.id, workerB.user.id), { code: '23503' });
  await assert.rejects(invalidEvidence(row.organizationId, row.id, workerA.user.id, orgB.organization.id), { code: '23514' });
  const insertJob = (org, inspectionId) => pool.query(`INSERT INTO background_jobs (id,organization_id,inspection_id,evidence_id,kind,dedupe_key)
    VALUES ($1,$2,$3,$4,'verify_evidence',$5)`, [randomUUID(), org, inspectionId, source.id, randomUUID()]);
  await assert.rejects(insertJob(row.organizationId, other.id), { code: '23503' });
  const foreign = await fresh(orgB, workerB);
  await assert.rejects(insertJob(foreign.organizationId, foreign.id), { code: '23503' });
  assert.equal((await runMigrations(pool, { info() {}, warn() {}, error() {} }, schema)).length, 0);
});

test('M4 routes reject foreign tenants, other workers, admin writes and injected ownership', async () => {
  const row = await fresh(), file = await attach(row);
  for (const actor of [workerB, workerA2]) {
    await send('get', `/inspections/${row.id}/evidence`, actor).expect(404);
    await send('get', `/inspections/${row.id}/evidence/${file.evidence.id}/download`, actor).expect(404);
    await send('post', `/inspections/${row.id}/evidence/${file.evidence.id}/upload`, actor, {}).expect(404);
    await send('post', `/inspections/${row.id}/evidence/remove`, actor, intent({ evidenceId: file.evidence.id, baseVersion: 2 })).expect(404);
  }
  await send('post', `/inspections/${row.id}/evidence/reserve`, orgA, file.body).expect(403);
  await send('post', `/inspections/${row.id}/evidence/reserve`, workerA, { ...file.body, organizationId: row.organizationId }).expect(400);
  const ownOther = await fresh();
  await send('get', `/inspections/${ownOther.id}/evidence/${file.evidence.id}/download`, workerA).expect(404);
  assert.equal((await send('get', `/inspections/${row.id}/evidence`, orgA).expect(200)).body.evidence.length, 1);
});

test('M4 real MinIO PUT signatures constrain keys, MIME, metadata and exact length; objects stay private', async () => {
  const row = await fresh(), file = await reserve(row);
  const deniedKey = `${evidencePrefix(orgB.organization.id, row.id, file.evidence.id)}/staging/${randomUUID()}`;
  const changedKey = new URL(file.descriptor.url);
  changedKey.pathname = `/${bucket}/${deniedKey}`;
  assert.equal((await putFile(file, {}, png, changedKey.href)).status, 403);
  assert.equal((await putFile(file, { 'Content-Type': 'image/jpeg' })).status, 403);
  assert.equal((await putFile(file, { 'x-amz-meta-sha256': '0'.repeat(64) })).status, 403);
  assert.ok(!(await putFile(file, {}, Buffer.concat([png, Buffer.from('x')]))).ok);
  assert.equal((await putFile(file)).status, 200);
  const anonymousUrl = new URL(file.descriptor.url); anonymousUrl.search = '';
  const anonymous = await fetch(anonymousUrl, { signal: AbortSignal.timeout(5000) });
  assert.equal(anonymous.status, 403);
  assert.equal(await exists(deniedKey), false);
});

test('M4 strict file validation rejects unknown fields, bad sizes, signatures, MIME and checksums', async () => {
  const row = await fresh();
  for (const change of [{ name: '../file.png' }, { mimeType: 'text/html' }, { size: 0 },
    { size: 10485761 }, { sha256: 'not-a-checksum' }, { objectKey: 'chosen-by-client' }]) {
    await send('post', `/inspections/${row.id}/evidence/reserve`, workerA,
      intent({ evidenceId: randomUUID(), name: 'field.png', mimeType: 'image/png', size: png.length, sha256: hash(png), ...change })).expect(400);
  }
  const invalidSignature = await reserve(row, { bytes: Buffer.from('this is not an image') });
  assert.equal((await putFile(invalidSignature)).status, 200);
  const badHash = await reserve(row);
  const altered = Buffer.from(png); altered[altered.length - 1] ^= 1;
  assert.equal((await putFile(badHash, {}, altered)).status, 200);
  const badMime = await reserve(row);
  await storage.client.send(new PutObjectCommand({ Bucket: bucket, Key: stagingKey(badMime), Body: png, ContentType: 'image/jpeg' }));
  for (const file of [invalidSignature, badHash, badMime]) {
    const response = await send('post', `/inspections/${row.id}/evidence`, workerA, intent({ evidenceId: file.evidence.id, baseVersion: row.version })).expect(400);
    assert.equal(response.body.error.code, 'INVALID_FILE');
    assert.equal((await metadata(file)).status, 'staging');
  }
  assert.equal((await detail(row)).inspection.version, 1);
  assert.equal((await objects(`org/${row.organizationId}/inspections/${row.id}/`)).filter((key) => key.includes('/verified/')).length, 0);
});

test('M4 promotion verifies bytes and commits membership, revision, audit, receipt and job once', async () => {
  const row = await fresh(), file = await attach(row, { ready: false });
  const record = await metadata(file), history = await detail(row);
  assert.ok(record.object_key.startsWith(`${evidencePrefix(row.organizationId, row.id, file.evidence.id)}/verified/`));
  assert.equal(history.inspection.version, 2);
  assert.equal(history.inspection.evidence[0].sha256, hash(png));
  assert.deepEqual(history.events.map((event) => event.eventType), ['created', 'evidence_attached']);
  assert.equal(history.revisions.length, 2);
  assert.equal((await jobFor(file)).status, 'queued');
  const deniedVerifiedUrl = new URL(file.descriptor.url);
  deniedVerifiedUrl.pathname = `/${bucket}/${record.object_key}`;
  assert.equal((await putFile(file, {}, png, deniedVerifiedUrl.href)).status, 403);
  await assert.rejects(storage.client.send(new PutObjectCommand({ Bucket: bucket, Key: record.object_key,
    Body: png, ContentType: 'image/png', IfNoneMatch: '*' })), (error) => error.$metadata?.httpStatusCode === 412);
  const download = await send('get', `/inspections/${row.id}/evidence/${file.evidence.id}/download`, workerA).expect(200);
  assert.deepEqual(download.body, png);
  await runJob(await jobFor(file));
  assert.equal((await metadata(file)).processing_status, 'ready');
  assert.equal((await detail(row)).inspection.version, 2);
});

test('M4 duplicate concurrent attachments and lost-response retries preserve one immutable object', async () => {
  const row = await fresh(), file = await reserve(row);
  assert.equal((await putFile(file)).status, 200);
  const body = intent({ evidenceId: file.evidence.id, baseVersion: 1 });
  const [first, duplicate] = await Promise.all([
    send('post', `/inspections/${row.id}/evidence`, workerA, body).expect(200),
    send('post', `/inspections/${row.id}/evidence`, workerA, body).expect(200),
  ]);
  assert.deepEqual(first.body, duplicate.body);
  assert.deepEqual((await send('post', `/inspections/${row.id}/evidence`, workerA, body).expect(200)).body, first.body);
  const changed = await send('post', `/inspections/${row.id}/evidence`, workerA, { ...body, baseVersion: 2 }).expect(409);
  assert.equal(changed.body.error.code, 'MUTATION_ID_REUSED');
  const prefix = evidencePrefix(row.organizationId, row.id, file.evidence.id);
  assert.equal((await objects(prefix)).filter((key) => key.includes('/verified/')).length, 1);
  assert.equal((await detail(row)).revisions.length, 2);
});

test('M4 audit, revision, receipt and job failures roll back membership and clean promoted candidates', async () => {
  for (const table of ['inspection_events', 'inspection_revisions', 'mutation_receipts', 'background_jobs']) {
    const row = await fresh(), file = await reserve(row);
    assert.equal((await putFile(file)).status, 200);
    const body = intent({ evidenceId: file.evidence.id, baseVersion: 1 });
    await pool.query(`CREATE FUNCTION m4_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected M4 write failure'; END $$`);
    await pool.query(`CREATE TRIGGER m4_reject BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION m4_reject()`);
    try {
      await send('post', `/inspections/${row.id}/evidence`, workerA, body).expect(500);
      assert.equal((await metadata(file)).status, 'staging');
      assert.equal((await detail(row)).inspection.version, 1);
      assert.equal((await detail(row)).revisions.length, 1);
      assert.equal((await objects(evidencePrefix(row.organizationId, row.id, file.evidence.id))).filter((key) => key.includes('/verified/')).length, 0);
      assert.equal(await exists(stagingKey(file)), true);
    } finally {
      await pool.query(`DROP TRIGGER m4_reject ON ${table}`);
      await pool.query('DROP FUNCTION m4_reject()');
    }
    await send('post', `/inspections/${row.id}/evidence`, workerA, body).expect(200);
    assert.equal((await detail(row)).inspection.version, 2);
  }
});

test('M4 removal is atomic, retryable and deletes both staging and verified bytes after commit', async () => {
  const row = await fresh(), file = await attach(row), record = await metadata(file);
  const body = intent({ evidenceId: file.evidence.id, baseVersion: 2 });
  await pool.query(`CREATE FUNCTION m4_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected removal failure'; END $$`);
  await pool.query('CREATE TRIGGER m4_reject BEFORE INSERT ON inspection_events FOR EACH ROW EXECUTE FUNCTION m4_reject()');
  try {
    await send('post', `/inspections/${row.id}/evidence/remove`, workerA, body).expect(500);
    assert.equal(await exists(record.object_key), true);
    assert.equal((await metadata(file)).status, 'attached');
  } finally {
    await pool.query('DROP TRIGGER m4_reject ON inspection_events');
    await pool.query('DROP FUNCTION m4_reject()');
  }
  const removed = (await send('post', `/inspections/${row.id}/evidence/remove`, workerA, body).expect(200)).body;
  assert.equal(removed.version, 3); assert.equal(removed.evidence.length, 0);
  assert.equal(await exists(record.object_key), false); assert.equal(await exists(record.staging_key), false);
  await send('post', `/inspections/${row.id}/evidence/remove`, workerA, body).expect(200);
  await runJob(await jobFor(file, 'cleanup_evidence'));
  await send('get', `/inspections/${row.id}/evidence/${file.evidence.id}/download`, workerA).expect(404);
  assert.equal((await detail(row)).revisions[1].snapshot.evidence.length, 1);
});

test('M4 pending and failed verification gate submission without consuming its stable mutation ID', async () => {
  const row = await fresh(), file = await attach(row, { ready: false });
  const body = intent({ ...content(row), baseVersion: 2 });
  const pending = await send('post', `/inspections/${row.id}/submit`, workerA, body).expect(409);
  assert.equal(pending.body.error.code, 'EVIDENCE_PROCESSING');
  assert.equal((await pool.query('SELECT 1 FROM mutation_receipts WHERE mutation_id=$1', [body.mutationId])).rowCount, 0);
  await pool.query("UPDATE evidence SET processing_status='failed' WHERE id=$1", [file.evidence.id]);
  const failed = await send('post', `/inspections/${row.id}/submit`, workerA, body).expect(409);
  assert.equal(failed.body.error.code, 'EVIDENCE_NOT_READY');
  await runJob(await jobFor(file));
  const submitted = (await send('post', `/inspections/${row.id}/submit`, workerA, body).expect(200)).body;
  assert.equal(submitted.version, 3); assert.equal(submitted.status, 'submitted');
  assert.deepEqual((await send('post', `/inspections/${row.id}/submit`, workerA, body).expect(200)).body, submitted);
});

test('M4 submitted, approved and cancelled inspections reject new evidence changes and staging overwrites cannot alter attachments', async () => {
  for (const state of ['submitted', 'approved', 'cancelled']) {
    const row = await fresh(), file = await attach(row), staged = await reserve(row);
    let current = file.inspection;
    if (state === 'cancelled') current = (await send('post', `/inspections/${row.id}/cancel`, orgA, intent({ baseVersion: 2, note: 'Cancelled' })).expect(200)).body;
    else current = (await send('post', `/inspections/${row.id}/submit`, workerA, intent({ ...content(row), baseVersion: 2 })).expect(200)).body;
    if (state === 'approved') current = (await send('post', `/inspections/${row.id}/review`, orgA, intent({ baseVersion: current.version, decision: 'approve', note: '' })).expect(200)).body;
    await send('post', `/inspections/${row.id}/evidence/remove`, workerA, intent({ evidenceId: file.evidence.id, baseVersion: current.version })).expect(409);
    await send('post', `/inspections/${row.id}/evidence/reserve`, workerA, { ...staged.body, evidenceId: randomUUID(), mutationId: randomUUID() }).expect(409);
    await send('post', `/inspections/${row.id}/evidence/${staged.evidence.id}/upload`, workerA, {}).expect(409);
    await send('post', `/inspections/${row.id}/evidence`, workerA, intent({ evidenceId: staged.evidence.id, baseVersion: current.version })).expect(409);
    assert.equal((await putFile(file, {}, Buffer.alloc(png.length, 1))).status, 200);
    assert.deepEqual((await send('get', `/inspections/${row.id}/evidence/${file.evidence.id}/download`, workerA).expect(200)).body, png);
    await send('post', `/inspections/${row.id}/evidence`, workerA, file.attachBody).expect(200);
    assert.equal((await detail(row)).inspection.version, current.version);
  }
});

test('M4 expired staging credentials renew on a new key and old cleanup jobs cannot delete the new upload', async () => {
  const row = await fresh(), file = await reserve(row);
  assert.equal((await putFile(file)).status, 200);
  const old = await jobFor(file, 'cleanup_stage'), oldKey = stagingKey(file);
  await pool.query("UPDATE evidence SET expires_at=now()-interval '1 second' WHERE id=$1", [file.evidence.id]);
  const expired = await send('post', `/inspections/${row.id}/evidence`, workerA, intent({ evidenceId: file.evidence.id, baseVersion: 1 })).expect(410);
  assert.equal(expired.body.error.code, 'UPLOAD_EXPIRED');
  file.descriptor = (await send('post', `/inspections/${row.id}/evidence/${file.evidence.id}/upload`, workerA, {}).expect(200)).body;
  assert.notEqual(stagingKey(file), oldKey);
  assert.equal((await putFile(file)).status, 200);
  await pool.query('UPDATE background_jobs SET run_after=now() WHERE id=$1', [old.id]);
  await runJob(old);
  assert.equal(await exists(oldKey), false); assert.equal(await exists(stagingKey(file)), true);
  await send('post', `/inspections/${row.id}/evidence`, workerA, intent({ evidenceId: file.evidence.id, baseVersion: 1 })).expect(200);
});

test('M4 orphan reconciliation retains live tenant objects and removes abandoned staging and rollback promotions', async () => {
  const a = await attach(await fresh()), b = await attach(await fresh(orgB, workerB), { actor: workerB });
  const abandoned = await reserve(await fresh()); assert.equal((await putFile(abandoned)).status, 200);
  await pool.query("UPDATE evidence SET expires_at=now()-interval '1 second' WHERE id=$1", [abandoned.evidence.id]);
  const orphan = `${evidencePrefix(orgA.organization.id, randomUUID(), randomUUID())}/verified/${randomUUID()}`;
  await storage.client.send(new PutObjectCommand({ Bucket: bucket, Key: orphan, Body: png, ContentType: 'image/png' }));
  await storage.client.send(new PutObjectCommand({ Bucket: bucket, Key: 'org/not-a-uuid/invalid', Body: png }));
  await reconcileObjects(pool, storage, new Date(Date.now() + 5000));
  assert.equal(await exists(orphan), false);
  assert.equal(await exists(stagingKey(abandoned)), false);
  assert.equal(await exists((await metadata(a)).object_key), true);
  assert.equal(await exists((await metadata(b)).object_key), true);
});

test('M4 a real MinIO cleanup denial leaves a rollback orphan that reconciliation removes safely', async () => {
  const row = await fresh(), file = await reserve(row);
  assert.equal((await putFile(file)).status, 200);
  const denied = createEvidenceStorage({ ...settings, S3_SECRET_ACCESS_KEY: 'invalid-test-signing-secret' });
  const remove = storage.remove;
  await pool.query(`CREATE FUNCTION m4_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected rollback'; END $$`);
  await pool.query('CREATE TRIGGER m4_reject BEFORE INSERT ON inspection_events FOR EACH ROW EXECUTE FUNCTION m4_reject()');
  storage.remove = (key) => denied.remove(key);
  try {
    await send('post', `/inspections/${row.id}/evidence`, workerA, intent({ evidenceId: file.evidence.id, baseVersion: 1 })).expect(500);
    assert.equal((await metadata(file)).status, 'staging');
    assert.equal((await objects(evidencePrefix(row.organizationId, row.id, file.evidence.id))).filter((key) => key.includes('/verified/')).length, 1);
  } finally {
    storage.remove = remove; denied.client.destroy();
    await pool.query('DROP TRIGGER m4_reject ON inspection_events');
    await pool.query('DROP FUNCTION m4_reject()');
  }
  await reconcileObjects(pool, storage, new Date(Date.now() + 5000));
  assert.equal((await objects(evidencePrefix(row.organizationId, row.id, file.evidence.id))).filter((key) => key.includes('/verified/')).length, 0);
  assert.equal(await exists(stagingKey(file)), true);
});

// This transport test uses the real API and S3 uploads with the shared pure
// outbox transitions. The separate browser harness verifies real Dexie blobs.
class EvidenceStore extends MemoryStore {
  constructor(rows) {
    super(rows, { organizationId: rows[0].organizationId, userId: rows[0].assignedTo });
    this.files = new Map(); this.blobs = new Map();
  }
  addFile(id, bytes = png) {
    const evidenceId = randomUUID(), mutationId = randomUUID();
    const metadata = localEvidenceSchema.parse({ ...this.owner, id: evidenceId, inspectionId: id, name: 'offline.png',
      mimeType: 'image/png', size: bytes.length, sha256: hash(bytes), reserveMutationId: randomUUID(), status: 'queued' });
    this.files.set(evidenceId, metadata); this.blobs.set(evidenceId, new Blob([bytes], { type: 'image/png' }));
    this.transition(id, (copy, queue) => ({ copy: { ...copy, generation: copy.generation + 1 },
      queue: [...queue, outboxEntrySchema.parse({ ...this.owner, mutationId, inspectionId: id, action: 'attach',
        body: { evidenceId, mutationId, baseVersion: copy.base.version }, base: copy.base, generation: copy.generation + 1,
        status: 'pending', attemptedAt: null, error: null })] }));
    return evidenceId;
  }
  async file(id) { return { metadata: this.files.get(id), blob: this.blobs.get(id) }; }
  ack(entry, response) {
    const result = super.ack(entry, response);
    if (entry.action === 'attach') { this.files.set(entry.body.evidenceId, { ...this.files.get(entry.body.evidenceId), status: 'synced' }); this.blobs.delete(entry.body.evidenceId); }
    return result;
  }
  defer(entry, message) {
    return this.transition(entry.inspectionId, (copy, queue) => ({ copy,
      queue: queue.map((row) => row.mutationId === entry.mutationId ? { ...row, error: message } : row) }));
  }
}
function transport(actor = workerA, observe = () => {}) {
  return async (path, options) => {
    const response = await send((options.method ?? 'GET').toLowerCase(), path, actor, options.body);
    observe(path, options, response);
    if (!response.ok) throw Object.assign(new Error(response.body.error.message), { status: response.status, code: response.body.error.code });
    return options.schema.parse(response.body);
  };
}

test('M4 offline replay uploads before submission, retries interrupted uploads and lost attachment responses unchanged', async () => {
  const row = await fresh(), unrelated = await fresh(), store = new EvidenceStore([row, unrelated]);
  store.save(row.id, content(row));
  const evidenceId = store.addFile(row.id);
  store.save(row.id, content(row), 'submit');
  store.save(unrelated.id, content(unrelated, 'Unrelated work keeps syncing'));
  let interrupted = true, lost = true, uploads = 0;
  const attempted = [];
  const request = transport(workerA, (path, options, response) => {
    if (path === `/inspections/${row.id}/evidence`) {
      attempted.push(structuredClone(options.body));
      if (response.ok && lost) { lost = false; throw new TypeError('Attachment response lost after commit'); }
    }
  });
  const upload = async (descriptor, blob) => {
    uploads++; await uploadBlob(descriptor, blob);
    if (interrupted) { interrupted = false; throw new TypeError('Upload interrupted after storage committed'); }
  };
  await assert.rejects(flushOutbox({ store, request, upload }), /Upload interrupted/);
  assert.equal(store.queue[0].action, 'attach'); assert.equal(store.queue[0].status, 'attempted');
  assert.equal(store.blobs.has(evidenceId), true); assert.equal((await detail(row)).inspection.version, 2);
  await assert.rejects(flushOutbox({ store, request, upload }), /response lost/);
  assert.equal(store.blobs.has(evidenceId), true); assert.equal((await detail(row)).inspection.version, 3);
  await flushOutbox({ store, request, upload });
  assert.equal(uploads, 1); assert.ok(attempted.every((body) => JSON.stringify(body) === JSON.stringify(attempted[0])));
  assert.equal(store.blobs.has(evidenceId), false);
  const queuedSubmit = store.queue.find((entry) => entry.inspectionId === row.id);
  assert.equal(queuedSubmit.action, 'submit'); assert.equal(queuedSubmit.status, 'attempted');
  assert.match(queuedSubmit.error, /verification/);
  assert.equal((await detail(unrelated)).inspection.version, 2);
  const file = { row, evidence: { id: evidenceId } };
  await runJob(await jobFor(file));
  await flushOutbox({ store, request, upload });
  assert.equal(store.queue.length, 0);
  const history = await detail(row);
  assert.equal(history.inspection.status, 'submitted'); assert.equal(history.inspection.version, 4);
  assert.deepEqual(history.events.map((event) => event.eventType), ['created', 'saved', 'evidence_attached', 'submitted']);
});

test('M4 offline files stay local on tenant switches and revoked assignments', async () => {
  const row = await fresh(), store = new EvidenceStore([row]);
  const evidenceId = store.addFile(row.id);
  await flushOutbox({ store, request: transport(workerB) });
  assert.equal(store.queue[0].status, 'pending'); assert.equal(store.blobs.has(evidenceId), true);
  const reassigned = await send('patch', `/inspections/${row.id}/assignment`, orgA, intent({ baseVersion: 1, assignedTo: workerA2.user.id })).expect(200);
  assert.equal(reassigned.body.assignedTo, workerA2.user.id);
  await flushOutbox({ store, request: transport() });
  assert.equal(store.queue[0].status, 'blocked'); assert.equal(store.blobs.has(evidenceId), true);
  assert.equal((await pool.query('SELECT 1 FROM evidence WHERE inspection_id=$1', [row.id])).rowCount, 0);
});

test('M4 offline replay refuses a local file whose inspection reference was changed', async () => {
  const row = await fresh(), store = new EvidenceStore([row]), id = store.addFile(row.id);
  store.files.set(id, { ...store.files.get(id), inspectionId: randomUUID() });
  await assert.rejects(flushOutbox({ store, request: transport() }), /another inspection or workspace/);
  assert.equal(store.blobs.has(id), true);
  assert.equal((await pool.query('SELECT 1 FROM evidence WHERE inspection_id=$1', [row.id])).rowCount, 0);
});

test('M4 a stale attachment retains its blob and an explicit merge retries with a fresh mutation ID', async () => {
  const row = await fresh(), store = new EvidenceStore([row]), id = store.addFile(row.id);
  const remote = (await send('patch', `/inspections/${row.id}`, workerA,
    intent({ ...content(row, 'Remote checklist'), baseVersion: 1 })).expect(200)).body;
  const oldId = store.queue[0].mutationId;
  let uploads = 0;
  const upload = async (descriptor, blob) => { uploads++; await uploadBlob(descriptor, blob); };
  await flushOutbox({ store, request: transport(), upload });
  assert.equal(store.queue[0].status, 'conflict'); assert.equal(store.blobs.has(id), true);
  const copy = store.copies.get(row.id);
  store.resolve(row.id, remote, contentOf(remote), 'save', copy.generation);
  assert.notEqual(store.queue[0].mutationId, oldId);
  assert.equal(store.queue[0].body.baseVersion, remote.version);
  await flushOutbox({ store, request: transport(), upload });
  assert.equal(uploads, 1); assert.equal(store.queue.length, 0); assert.equal(store.blobs.has(id), false);
  const result = (await detail(row)).inspection;
  assert.equal(result.version, 3); assert.equal(result.reportText, 'Remote checklist');
  assert.equal(result.evidence[0].id, id);
});

test('M4 real BullMQ executes verification and version-bound report archives; duplicate delivery is harmless', async () => {
  const row = await fresh(), file = await attach(row, { ready: false }), verification = await jobFor(file);
  await withRuntime(async (runtime) => {
    await poll(async () => (await metadata(file)).processing_status === 'ready', 'BullMQ verification');
    const duplicate = await runtime.queue.add('process', { organizationId: row.organizationId, jobId: verification.id }, { jobId: randomUUID() });
    await poll(async () => (await duplicate.getState()) === 'completed', 'duplicate queue delivery');
    assert.equal((await jobFor(file)).attempts, 1);
    const submitted = (await send('post', `/inspections/${row.id}/submit`, workerA,
      intent({ ...content(row, '<script>alert(1)</script> original report'), baseVersion: 2 })).expect(200)).body;
    const archive = await poll(async () => (await pool.query("SELECT * FROM background_jobs WHERE inspection_id=$1 AND kind='prepare_report' AND status='completed'", [row.id])).rows[0], 'report archive');
    assert.equal(archive.result.sourceVersion, submitted.version);
    const response = await send('get', `/inspections/${row.id}/archives/${archive.id}`, workerA).expect(200);
    assert.match(response.text, /&lt;script&gt;/); assert.ok(!response.text.includes('<script>'));
    assert.match(response.headers['content-security-policy'], /sandbox/);
    await send('get', `/inspections/${row.id}/archives/${archive.id}`, workerB).expect(404);
    await send('get', `/inspections/${row.id}/jobs`, workerB).expect(404);
    const changed = (await send('post', `/inspections/${row.id}/review`, orgA,
      intent({ baseVersion: submitted.version, decision: 'request_changes', note: 'Add detail' })).expect(200)).body;
    await send('patch', `/inspections/${row.id}`, workerA, intent({ ...content(row, 'New report text'), baseVersion: changed.version })).expect(200);
    assert.match((await send('get', `/inspections/${row.id}/archives/${archive.id}`, workerA).expect(200)).text, /original report/);
  });
});

test('M4 BullMQ retries a real MinIO read failure and PostgreSQL keeps the required work', async () => {
  const row = await fresh(), file = await attach(row, { ready: false }), record = await metadata(file);
  await storage.remove(record.object_key);
  await withRuntime(async () => {
    await poll(async () => (await jobFor(file)).status === 'retry', 'durable S3 retry');
    assert.equal((await metadata(file)).processing_status, 'pending');
    await storage.client.send(new PutObjectCommand({ Bucket: bucket, Key: record.object_key, Body: png, ContentType: 'image/png', IfNoneMatch: '*' }));
    await poll(async () => (await metadata(file)).processing_status === 'ready', 'recovered S3 verification');
    assert.equal((await jobFor(file)).attempts, 2);
    assert.equal((await detail(row)).inspection.version, 2);
  });
});

test('M4 reconciliation republishes SQL work when its Redis queue entry is lost', async () => {
  const file = await attach(await fresh(), { ready: false }), job = await jobFor(file);
  const queue = new Queue('fieldsync-jobs', { connection: redisOptions(), prefix: schema });
  try {
    const queued = await queue.add('process', { organizationId: job.organization_id, jobId: job.id }, { jobId: job.id });
    await queued.remove();
  } finally { await queue.close(); }
  await withRuntime(async () => {
    await poll(async () => (await jobFor(file)).status === 'completed', 'republished SQL job');
    assert.equal((await metadata(file)).processing_status, 'ready');
  });
});

test('M4 a real worker process crash recovers its lease or settles an exhausted final attempt', async () => {
  for (const startingAttempts of [0, 4]) {
    const row = await fresh(), file = await attach(row, { ready: false }), job = await jobFor(file);
    await pool.query('UPDATE background_jobs SET attempts=$2 WHERE id=$1', [job.id, startingAttempts]);
    const child = fork(fileURLToPath(new URL('./helpers/m4-crash-worker.js', import.meta.url)),
      [schema, bucket, row.organizationId, job.id], { silent: true });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Crash worker did not claim its job')), 10000);
        child.once('message', (message) => { clearTimeout(timer); message.claimed ? resolve() : reject(new Error('Crash worker failed before its lease')); });
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
      });
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
      assert.equal((await jobFor(file)).status, 'running');
      // Advance just the test lease rather than waiting a minute in the suite.
      await pool.query("UPDATE background_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [job.id]);
      await withRuntime(async () => {
        if (startingAttempts === 0) {
          await poll(async () => (await jobFor(file)).status === 'completed', 'crashed worker recovery');
          assert.equal((await jobFor(file)).attempts, 2);
          assert.equal((await metadata(file)).processing_status, 'ready');
        } else {
          await poll(async () => (await jobFor(file)).status === 'failed', 'exhausted crash settlement');
          assert.equal((await metadata(file)).processing_status, 'failed');
          assert.equal((await jobFor(file)).attempts, 5);
        }
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    }
  }
});

test('M4 lease tokens fence stale workers and a foreign job pointer cannot claim work', async () => {
  const row = await fresh(), file = await attach(row, { ready: false }), job = await jobFor(file);
  await processJob({ pool, storage }, { organizationId: orgB.organization.id, jobId: job.id });
  assert.equal((await jobFor(file)).attempts, 0);
  let entered, release;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const old = processJob({ pool, storage: { ...storage, async read(key, expected) {
    await storage.read(key, expected); entered(); await gate; throw new Error('stale worker failure');
  } } }, { organizationId: row.organizationId, jobId: job.id });
  try {
    await started;
    await pool.query("UPDATE background_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [job.id]);
    await runJob(job);
    release();
    await assert.rejects(old, /stale worker failure/);
    assert.equal((await jobFor(file)).status, 'completed');
    assert.equal((await jobFor(file)).attempts, 2);
    assert.equal((await metadata(file)).processing_status, 'ready');
    await recoverExpiredJobs(pool);
    assert.equal((await detail(row)).inspection.version, 2);
  } finally { release(); await old.catch(() => {}); }
});

test('M4 persistent MinIO failures exhaust five durable attempts and cannot leave submission pending forever', async () => {
  const row = await fresh(), file = await attach(row, { ready: false }), job = await jobFor(file);
  await storage.remove((await metadata(file)).object_key);
  for (let attempt = 1; attempt <= 5; attempt++) {
    await pool.query('UPDATE background_jobs SET run_after=now() WHERE id=$1', [job.id]);
    await assert.rejects(runJob(job), { code: 'UPLOAD_MISSING' });
    const current = await jobFor(file);
    assert.equal(current.attempts, attempt);
    assert.equal(current.status, attempt === 5 ? 'failed' : 'retry');
  }
  await runJob(job);
  assert.equal((await jobFor(file)).attempts, 5);
  assert.equal((await metadata(file)).processing_status, 'failed');
  const response = await send('post', `/inspections/${row.id}/submit`, workerA, intent({ ...content(row), baseVersion: 2 })).expect(409);
  assert.equal(response.body.error.code, 'EVIDENCE_NOT_READY');
  assert.equal((await detail(row)).inspection.version, 2);
});
