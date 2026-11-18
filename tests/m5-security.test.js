import test,{ before,after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { dirname,basename } from 'node:path';
import supertest from 'supertest';
import { createFixture,poll } from './helpers/m5.js';
import { EnvironmentSchema } from '../apps/server/src/config/schema.js';
import { createApp } from '../apps/server/src/app.js';
import { createPool } from '../apps/server/src/infrastructure/database.js';
import { createRateLimits } from '../apps/server/src/http/rate-limit.js';

let f;
before(async()=>{ f=await createFixture('m5security'); });
after(async()=>{ await f?.close(); });

test('M5 auth bursts are limited by the actual peer while untrusted forwarded headers cannot bypass the guard',async()=>{
  const app=createApp({ pool:f.pool,storage:f.storage,env:{ ...f.settings,AUTH_RATE_LIMIT:2 },logger:f.logger,getHealth:async()=>({}) });
  const body={ organizationId:randomUUID(),email:'missing@example.test',password:f.password };
  for(let index=0;index<2;index++) await supertest(app).post('/api/v1/auth/login').set('Origin',f.origin).send(body).expect(401);
  const response=await supertest(app).post('/api/v1/auth/login').set('Origin',f.origin).set('X-Forwarded-For','203.0.113.99').send(body).expect(429);
  assert.equal(response.body.error.code,'RATE_LIMITED'); assert.ok(Number(response.headers['retry-after'])>0);
  await supertest(app).post('/api/v1/auth/login').set('Origin','https://foreign.example.test').send(body).expect(403);
});

test('M5 per-tenant/user burst windows reset without retaining unbounded identity state',()=>{
  let time=1000,accepted=0; const limits=createRateLimits({ AI_RATE_LIMIT:1 },()=>time),res={ set(){} };
  const a={ auth:{ organizationId:randomUUID(),user:{ id:randomUUID() } } },b={ auth:{ organizationId:randomUUID(),user:{ id:randomUUID() } } };
  limits.ai(a,res,()=>accepted++); assert.throws(()=>limits.ai(a,res,()=>accepted++),(error)=>error.code==='RATE_LIMITED');
  limits.ai(b,res,()=>accepted++); time+=60001; limits.ai(a,res,()=>accepted++); assert.equal(accepted,3);
});

test('M5 production configuration accepts hosting URLs, keeps optional AI keys optional and rejects insecure storage/proxy/invalid URL settings',()=>{
  const minimum={ NODE_ENV:'production',APP_ORIGIN:'https://fieldsync.example.test',S3_ENDPOINT:'https://storage.example.test',S3_PUBLIC_ENDPOINT:'https://storage.example.test',
    S3_ACCESS_KEY_ID:'test-access',S3_SECRET_ACCESS_KEY:'test-secret-key',DATABASE_URL:'postgresql://test:test-password@db.example.test/fieldsync',REDIS_URL:'redis://redis.example.test:6379',
    POSTGRES_SSL:'true',AI_ENABLED:'true' };
  const settings=EnvironmentSchema.parse(minimum); assert.equal(settings.POSTGRES_SSL,true); assert.equal(settings.OPENAI_API_KEY,undefined);
  for(const extra of [{ APP_ORIGIN:'http://localhost' },{ S3_ENDPOINT:'http://storage.example.test' },{ TRUST_PROXY_HOPS:'2' },{ DATABASE_URL:'bad' },{ REDIS_URL:'bad' },{ REDIS_URL:'redis://localhost/not-a-db' }]) {
    assert.equal(EnvironmentSchema.safeParse({ ...minimum,...extra }).success,false);
  }
});

test('M5 hosting URL adapters connect to actual PostgreSQL/Redis while preserving the isolated schema and queue',async()=>{
  const password=encodeURIComponent(f.settings.POSTGRES_PASSWORD),user=encodeURIComponent(f.settings.POSTGRES_USER);
  const pool=createPool({ ...f.settings,DATABASE_URL:`postgresql://${user}:${password}@${f.settings.POSTGRES_HOST}:${f.settings.POSTGRES_PORT}/${f.settings.POSTGRES_DB}` },{ schema:f.schema });
  try { assert.equal((await pool.query('SELECT count(*)::int AS n FROM organizations')).rows[0].n,2); } finally { await pool.end(); }
  const original=f.settings.REDIS_URL;
  f.settings.REDIS_URL=`redis://:${encodeURIComponent(f.settings.REDIS_PASSWORD)}@${f.settings.REDIS_HOST}:${f.settings.REDIS_PORT}/0`;
  try {
    const row=await f.fresh(),artifact=await f.request(row);
    await f.runtime(async()=>{ await poll(async()=> (await f.artifact(row,artifact.id)).status==='ready','URL-configured BullMQ'); });
  } finally { f.settings.REDIS_URL=original; }
});

test('M5 production host serves a shell while preserving API 404s, CSP, microphone permissions and private no-store responses',async()=>{
  const directory=await mkdtemp(resolve(tmpdir(),'fieldsync-m5-host-'));
  try {
    await writeFile(resolve(directory,'index.html'),'<!doctype html><html><body>FieldSync test shell</body></html>');
    const app=createApp({ pool:f.pool,storage:f.storage,env:f.settings,logger:f.logger,getHealth:async()=>({}),webDirectory:directory });
    const response=await supertest(app).get('/inspections/test').set('Accept','text/html').expect(200);
    assert.match(response.text,/FieldSync test shell/); assert.match(response.headers['content-security-policy'],/connect-src 'self' http:\/\/localhost:9000/);
    assert.match(response.headers['permissions-policy'],/microphone=\(self\)/); assert.equal(response.headers['cache-control'],'no-store');
    await supertest(app).get('/api/v1/missing').expect(404).expect((res)=>assert.equal(res.body.error.code,'NOT_FOUND'));
    const analytics=await supertest(app).get('/api/v1/analytics').set('Cookie',f.orgA.cookie).expect(200);
    assert.equal(analytics.headers['cache-control'],'no-store'); assert.match(analytics.headers['x-content-type-options'],/nosniff/);
    assert.ok(!JSON.stringify(analytics.body).includes(f.settings.S3_SECRET_ACCESS_KEY));
  } finally {
    assert.equal(dirname(resolve(directory)),resolve(tmpdir())); assert.match(basename(directory),/^fieldsync-m5-host-/);
    await rm(directory,{ recursive:true,force:true });
  }
});
