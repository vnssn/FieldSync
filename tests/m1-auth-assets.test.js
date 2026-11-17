import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import request from 'supertest';
import { authResponseSchema, assetDetailSchema, assetSchema, usersResponseSchema } from '@fieldsync/contracts';
import { env } from '../apps/server/src/config/env.js';
import { createPool } from '../apps/server/src/infrastructure/database.js';
import { runMigrations } from '../apps/server/src/infrastructure/migrations.js';
import { createLogger } from '../apps/server/src/infrastructure/logger.js';
import { createHealthCheck } from '../apps/server/src/modules/health/service.js';
import { cookieOptions } from '../apps/server/src/modules/auth/session.js';
import { createApp } from '../apps/server/src/app.js';

const schema = `fieldsync_m1_${randomUUID().replaceAll('-', '')}`;
const origin = new URL(env.APP_ORIGIN).origin;
const password = 'Integration-test-password-27';
const quiet = { info() {}, warn() {}, error() {}, debug() {}, log() {} };
let adminPool;
let pool;
let server;
let orgA;
let orgB;

function cookieOf(response) { return response.headers['set-cookie'][0].split(';')[0]; }
function digestCookie(cookie) { return createHash('sha256').update(cookie.split('=')[1]).digest('hex'); }
function post(path, cookie) {
  const req = request(server).post(`/api/v1${path}`).set('Origin', origin);
  return cookie ? req.set('Cookie', cookie) : req;
}
function patch(path, cookie) { return request(server).patch(`/api/v1${path}`).set('Origin', origin).set('Cookie', cookie); }
function get(path, cookie) {
  const req = request(server).get(`/api/v1${path}`);
  return cookie ? req.set('Cookie', cookie) : req;
}
async function register(name, email = 'admin@example.test') {
  const response = await post('/auth/register-org').send({ organizationName: name, name: `${name} Admin`, email, password }).expect(201);
  return { ...authResponseSchema.parse(response.body), cookie: cookieOf(response) };
}
async function createAsset(owner, code = randomUUID()) {
  const response = await post('/assets', owner.cookie).send({ code, name: 'Pump station', category: 'Pump', location: 'North yard' }).expect(201);
  return assetSchema.parse(response.body);
}

before(async () => {
  adminPool = createPool(env);
  // This identifier is generated here, checked before use, and never comes from the environment.
  assert.match(schema, /^fieldsync_m1_[a-f0-9]{32}$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  pool = createPool(env, { schema });
  await runMigrations(pool, quiet, schema);
  const logger = createLogger('silent');
  server = createServer(createApp({ pool, env, logger, getHealth: createHealthCheck({ pool, env, logger }) }));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  orgA = await register('Integration A');
  orgB = await register('Integration B');
});

after(async () => {
  try {
    if (server?.listening) await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  } finally {
    try { if (pool) await pool.end(); }
    finally {
      if (adminPool) {
        try {
          assert.match(schema, /^fieldsync_m1_[a-f0-9]{32}$/);
          await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        } finally { await adminPool.end(); }
      }
    }
  }
});

test('registration, tenant-qualified login, me and logout use real PostgreSQL sessions', async () => {
  const response = await post('/auth/register-org').send({
    organizationName: 'Lifecycle org', name: 'Lifecycle admin', email: ' OWNER@EXAMPLE.TEST ', password,
  }).expect(201);
  const identity = authResponseSchema.parse(response.body);
  assert.equal(identity.user.email, 'owner@example.test');
  assert.equal(identity.user.role, 'admin');
  const cookie = cookieOf(response);
  assert.match(response.headers['set-cookie'][0], /HttpOnly/);
  assert.match(response.headers['set-cookie'][0], /SameSite=Lax/);
  assert.match(response.headers['set-cookie'][0], /Path=\//);
  assert.equal(cookieOptions({ ...env, NODE_ENV: 'production' }).secure, true);
  assert.equal(cookieOptions({ ...env, APP_ORIGIN: 'https://example.test' }).secure, true);
  const stored = await pool.query('SELECT password_hash FROM users WHERE organization_id = $1 AND id = $2', [identity.organization.id, identity.user.id]);
  assert.match(stored.rows[0].password_hash, /^\$argon2id\$/);
  assert.equal(JSON.stringify(identity).includes('password'), false);
  const sessions = await pool.query('SELECT id FROM sessions WHERE organization_id = $1 AND user_id = $2', [identity.organization.id, identity.user.id]);
  assert.equal(sessions.rows[0].id, digestCookie(cookie));
  assert.notEqual(sessions.rows[0].id, cookie.split('=')[1]);
  const me = await get('/auth/me', cookie).expect(200);
  assert.deepEqual(me.body, identity);
  assert.equal(me.headers['cache-control'], 'no-store');
  await post('/auth/login').send({ organizationId: identity.organization.id, email: identity.user.email, password: 'Incorrect-password-27' }).expect(401);
  const login = await post('/auth/login', cookie).send({ organizationId: identity.organization.id, email: identity.user.email, password }).expect(200);
  const freshCookie = cookieOf(login);
  assert.notEqual(cookie, freshCookie);
  await get('/auth/me', cookie).expect(401);
  await get('/auth/me', freshCookie).expect(200);
  const logout = await post('/auth/logout', freshCookie).send({}).expect(204);
  assert.match(logout.headers['set-cookie'][0], /Expires=Thu, 01 Jan 1970/);
  await get('/auth/me', freshCookie).expect(401);
  await get('/auth/me').expect(401);
});

test('worker reads assets but cannot list/provision users or create/update assets', async () => {
  const created = await post('/users', orgA.cookie).send({ name: 'Worker A', email: 'worker@example.test', password }).expect(201);
  assert.equal(created.body.role, 'worker');
  assert.equal(created.body.organizationId, orgA.organization.id);
  const login = await post('/auth/login').send({ organizationId: orgA.organization.id, email: 'worker@example.test', password }).expect(200);
  const cookie = cookieOf(login);
  const asset = await createAsset(orgA);
  await get('/assets', cookie).expect(200);
  await get(`/assets/${asset.id}`, cookie).expect(200);
  await get('/users', cookie).expect(403);
  await post('/users', cookie).send({ name: 'Unauthorized', email: 'blocked@example.test', password }).expect(403);
  await post('/assets', cookie).send({ code: 'blocked', name: 'Blocked', category: 'Pump', location: 'Yard' }).expect(403);
  await patch(`/assets/${asset.id}`, cookie).send({ name: 'Blocked', baseVersion: 1 }).expect(403);
  assert.equal((await get(`/assets/${asset.id}`, orgA.cookie)).body.asset.version, 1);
});

test('tenant lists and asset IDs cannot expose or mutate another organization', async () => {
  const a = await createAsset(orgA, 'SHARED-CODE');
  const b = await createAsset(orgB, 'SHARED-CODE');
  const usersA = usersResponseSchema.parse((await get('/users', orgA.cookie).expect(200)).body).users;
  assert.ok(usersA.every((user) => user.organizationId === orgA.organization.id));
  assert.ok(!usersA.some((user) => user.id === orgB.user.id));
  const assetsA = (await get('/assets?status=all', orgA.cookie).expect(200)).body.assets;
  assert.ok(assetsA.some((asset) => asset.id === a.id));
  assert.ok(!assetsA.some((asset) => asset.id === b.id));
  assert.ok(assetsA.every((asset) => asset.organizationId === orgA.organization.id));
  await get(`/assets/${b.id}`, orgA.cookie).expect(404);
  await get(`/assets/${a.id}`, orgB.cookie).expect(404);
  await patch(`/assets/${b.id}`, orgA.cookie).send({ name: 'Cross-tenant edit', baseVersion: 1 }).expect(404);
  await get(`/users/${orgB.user.id}`, orgA.cookie).expect(404);
  await patch(`/users/${orgB.user.id}`, orgA.cookie).send({ name: 'Cross-tenant edit' }).expect(404);
  await get(`/users?organizationId=${orgB.organization.id}`, orgA.cookie).expect(400);
  await get(`/assets?organizationId=${orgB.organization.id}`, orgA.cookie).expect(400);
  await post('/users', orgA.cookie).send({ name: 'Injected', email: 'injected@example.test', password, organizationId: orgB.organization.id }).expect(400);
  await post('/users', orgA.cookie).send({ name: 'Escalated', email: 'escalated@example.test', password, role: 'admin' }).expect(400);
  await post('/assets', orgA.cookie).send({ code: 'Injected', name: 'Injected', category: 'Pump', location: 'Yard', organizationId: orgB.organization.id }).expect(400);
  assert.equal((await get(`/assets/${b.id}`, orgB.cookie)).body.asset.name, 'Pump station');
});

test('composite foreign keys reject cross-tenant sessions, creators, assets and event actors', async () => {
  const a = await createAsset(orgA);
  const b = await createAsset(orgB);
  const rejectsForeignKey = (sql, values) => assert.rejects(pool.query(sql, values), { code: '23503' });
  await rejectsForeignKey('INSERT INTO sessions (id, organization_id, user_id, expires_at) VALUES ($1, $2, $3, now() + interval \'1 hour\')', [randomUUID(), orgA.organization.id, orgB.user.id]);
  await rejectsForeignKey(`INSERT INTO assets (id, organization_id, code, name, category, location, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7)`, [randomUUID(), orgA.organization.id, 'bad-fk', 'Bad', 'Pump', 'Yard', orgB.user.id]);
  await rejectsForeignKey(`INSERT INTO asset_events (id, organization_id, asset_id, actor_user_id, event_type)
    VALUES ($1, $2, $3, $4, $5)`, [randomUUID(), orgA.organization.id, b.id, orgA.user.id, 'updated']);
  await rejectsForeignKey(`INSERT INTO asset_events (id, organization_id, asset_id, actor_user_id, event_type)
    VALUES ($1, $2, $3, $4, $5)`, [randomUUID(), orgA.organization.id, a.id, orgB.user.id, 'updated']);
});

test('asset creation, metadata updates, archival and restoration produce chronological audit history', async () => {
  const asset = await createAsset(orgA, 'LIFECYCLE-ASSET');
  assert.equal(asset.version, 1);
  assert.equal(asset.status, 'active');
  const updated = await patch(`/assets/${asset.id}`, orgA.cookie).send({ name: 'Updated pump', location: 'South yard', baseVersion: 1 }).expect(200);
  assert.equal(updated.body.version, 2);
  await patch(`/assets/${asset.id}`, orgA.cookie).send({ status: 'archived', baseVersion: 2 }).expect(200);
  const active = (await get('/assets?status=active', orgA.cookie)).body.assets;
  assert.ok(!active.some((entry) => entry.id === asset.id));
  const archived = (await get('/assets?status=archived&q=LIFECYCLE', orgA.cookie)).body.assets;
  assert.deepEqual(archived.map((entry) => entry.id), [asset.id]);
  await patch(`/assets/${asset.id}`, orgA.cookie).send({ status: 'active', baseVersion: 3 }).expect(200);
  const detail = assetDetailSchema.parse((await get(`/assets/${asset.id}`, orgA.cookie).expect(200)).body);
  assert.equal(detail.asset.version, 4);
  assert.deepEqual(detail.events.map((event) => event.eventType), ['created', 'updated', 'archived', 'restored']);
  assert.deepEqual(detail.events[1].changes.name, { before: 'Pump station', after: 'Updated pump' });
  assert.deepEqual(detail.events[2].changes.status, { before: 'active', after: 'archived' });
  assert.ok(detail.events.every((event) => event.actorUserId === orgA.user.id && event.organizationId === orgA.organization.id));
  assert.deepEqual(detail.events.map((event) => event.createdAt), detail.events.map((event) => event.createdAt).sort());
});

test('strict Zod boundaries reject malformed, oversized and server-controlled inputs', async () => {
  const asset = await createAsset(orgA);
  await post('/auth/register-org').send({ organizationName: '', name: '', email: 'invalid', password: 'short' }).expect(400);
  await post('/auth/login').send({ email: 'admin@example.test', password }).expect(400);
  await post('/users', orgA.cookie).send({ name: '', email: 'invalid', password: 'short' }).expect(400);
  await post('/assets', orgA.cookie).send({ code: '', name: '', category: '', location: '' }).expect(400);
  await patch(`/assets/${asset.id}`, orgA.cookie).send({ status: 'deleted', baseVersion: 1 }).expect(400);
  await patch(`/assets/${asset.id}`, orgA.cookie).send({ name: 'New', baseVersion: '1' }).expect(400);
  await patch(`/assets/${asset.id}`, orgA.cookie).send({ name: 'New', baseVersion: 1, createdBy: orgB.user.id }).expect(400);
  await patch(`/assets/${asset.id}`, orgA.cookie).send({ baseVersion: 1 }).expect(400);
  await get('/assets/not-a-uuid', orgA.cookie).expect(400);
  await get('/assets?status=deleted', orgA.cookie).expect(400);
  await get('/assets?q=a&q=b', orgA.cookie).expect(400);
  await post('/assets', orgA.cookie).set('Content-Type', 'application/json').send('{bad json').expect(400);
  await post('/assets', orgA.cookie).send({ name: 'x'.repeat(40000) }).expect(413);
  const detail = (await get(`/assets/${asset.id}`, orgA.cookie)).body;
  assert.equal(detail.asset.version, 1);
  assert.equal(detail.events.length, 1);
});

test('CSRF protection rejects absent, null and foreign origins, including login and registration', async () => {
  const body = { organizationName: 'CSRF', name: 'CSRF', email: 'csrf@example.test', password };
  for (const suppliedOrigin of [undefined, 'null', 'https://attacker.example']) {
    let req = request(server).post('/api/v1/auth/register-org');
    if (suppliedOrigin) req = req.set('Origin', suppliedOrigin);
    await req.send(body).expect(403);
  }
  await request(server).post('/api/v1/auth/login').set('Origin', 'https://attacker.example').send({ organizationId: orgA.organization.id, email: orgA.user.email, password }).expect(403);
  await request(server).post('/api/v1/auth/logout').set('Cookie', orgA.cookie).send({}).expect(403);
  const asset = await createAsset(orgA);
  await request(server).patch(`/api/v1/assets/${asset.id}`).set('Cookie', orgA.cookie).send({ name: 'CSRF', baseVersion: 1 }).expect(403);
  await post('/users', orgA.cookie).type('form').send({ name: 'CSRF' }).expect(415);
});

test('expired and malformed session credentials cannot access protected resources', async () => {
  const owner = await register('Expiry org');
  await pool.query('UPDATE sessions SET expires_at = now() - interval \'1 minute\' WHERE organization_id = $1 AND user_id = $2', [owner.organization.id, owner.user.id]);
  await get('/auth/me', owner.cookie).expect(401);
  await get('/assets', owner.cookie).expect(401);
  await get('/users', 'fieldsync_sid=bad-token').expect(401);
  await get('/auth/me', `${orgA.cookie}; ${orgA.cookie}`).expect(401);
  await post('/assets').send({ code: 'Anon', name: 'Anon', category: 'Pump', location: 'Yard' }).expect(401);
});

test('duplicate email and asset code fail within a tenant while identical values work across tenants', async () => {
  await post('/users', orgA.cookie).send({ name: 'Duplicate', email: orgA.user.email.toUpperCase(), password }).expect(409);
  const a = await createAsset(orgA, 'DUPLICATE-CODE');
  const duplicate = await post('/assets', orgA.cookie).send({ code: a.code, name: 'Duplicate', category: 'Pump', location: 'Yard' }).expect(409);
  assert.equal(duplicate.body.error.code, 'DUPLICATE_ASSET_CODE');
  await createAsset(orgB, a.code);
  const loginA = await post('/auth/login').send({ organizationId: orgA.organization.id, email: orgA.user.email, password }).expect(200);
  const loginB = await post('/auth/login').send({ organizationId: orgB.organization.id, email: orgB.user.email, password }).expect(200);
  assert.notEqual(loginA.body.organization.id, loginB.body.organization.id);
});

test('stale and concurrent asset updates never overwrite newer versions or create extra audit events', async () => {
  const asset = await createAsset(orgA);
  const responses = await Promise.all([
    patch(`/assets/${asset.id}`, orgA.cookie).send({ name: 'First contender', baseVersion: 1 }),
    patch(`/assets/${asset.id}`, orgA.cookie).send({ name: 'Second contender', baseVersion: 1 }),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  assert.equal(responses.find((response) => response.status === 409).body.error.code, 'VERSION_CONFLICT');
  const detail = (await get(`/assets/${asset.id}`, orgA.cookie)).body;
  assert.equal(detail.asset.version, 2);
  assert.equal(detail.events.length, 2);
  await patch(`/assets/${asset.id}`, orgA.cookie).send({ name: detail.asset.name, baseVersion: 2 }).expect(400);
});

test('search treats SQL and LIKE metacharacters as literal input', async () => {
  const asset = await createAsset(orgA, 'PUMP%_literal');
  const result = await get('/assets?q=%25_', orgA.cookie).expect(200);
  assert.deepEqual(result.body.assets.map((entry) => entry.id), [asset.id]);
  const injection = await get(`/assets?q=${encodeURIComponent("' OR 1=1 --")}`, orgA.cookie).expect(200);
  assert.deepEqual(injection.body.assets, []);
});

test('failed audit inserts roll back both asset creation and metadata updates', async () => {
  const asset = await createAsset(orgA);
  await pool.query(`CREATE FUNCTION reject_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Deliberate integration-test failure'; END $$`);
  await pool.query('CREATE TRIGGER reject_test_audit BEFORE INSERT ON asset_events FOR EACH ROW EXECUTE FUNCTION reject_test_audit()');
  try {
    await post('/assets', orgA.cookie).send({ code: 'ROLLBACK-ASSET', name: 'Rollback', category: 'Pump', location: 'Yard' }).expect(500);
    await patch(`/assets/${asset.id}`, orgA.cookie).send({ name: 'Rollback edit', baseVersion: 1 }).expect(500);
    const count = await pool.query('SELECT id FROM assets WHERE organization_id = $1 AND code = $2', [orgA.organization.id, 'ROLLBACK-ASSET']);
    assert.equal(count.rows.length, 0);
    const detail = (await get(`/assets/${asset.id}`, orgA.cookie)).body;
    assert.equal(detail.asset.name, asset.name);
    assert.equal(detail.asset.version, 1);
    assert.equal(detail.events.length, 1);
  } finally {
    await pool.query('DROP TRIGGER reject_test_audit ON asset_events');
    await pool.query('DROP FUNCTION reject_test_audit()');
  }
});

test('failed session insertion rolls back organization and administrator registration', async () => {
  await pool.query(`CREATE FUNCTION reject_test_session() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Deliberate integration-test failure'; END $$`);
  await pool.query('CREATE TRIGGER reject_test_session BEFORE INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION reject_test_session()');
  try {
    await post('/auth/register-org').send({ organizationName: 'ROLLBACK-ORG', name: 'Rollback', email: 'rollback@example.test', password }).expect(500);
    assert.equal((await pool.query('SELECT id FROM organizations WHERE name = $1', ['ROLLBACK-ORG'])).rows.length, 0);
    assert.equal((await pool.query('SELECT id FROM users WHERE email = $1', ['rollback@example.test'])).rows.length, 0);
  } finally {
    await pool.query('DROP TRIGGER reject_test_session ON sessions');
    await pool.query('DROP FUNCTION reject_test_session()');
  }
});

test('rerunning migrations is a no-op against the real test database', async () => {
  const applied = await runMigrations(pool, quiet, schema);
  assert.equal(applied.length, 0);
  const migrations = await pool.query('SELECT name FROM pgmigrations ORDER BY id');
  assert.deepEqual(migrations.rows.map((row) => row.name), ['001_init_auth', '002_init_assets', '003_init_inspections', '004_init_evidence_jobs']);
});
