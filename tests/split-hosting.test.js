import test,{ before,after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID,createHash } from 'node:crypto';
import supertest from 'supertest';
import { EnvironmentSchema } from '../apps/server/src/config/schema.js';
import { createApp } from '../apps/server/src/app.js';
import { createLogger } from '../apps/server/src/infrastructure/logger.js';
import { cookieOptions } from '../apps/server/src/modules/auth/session.js';
import { createCloudinaryStorage } from '../apps/server/src/infrastructure/cloudinary-storage.js';
import { cloudinaryFixture,cloudinarySettings } from './helpers/cloudinary.js';
import { createFixture,png,intent } from './helpers/m5.js';

const origin='https://production.example.test',legacy='https://legacy.example.test';
const settings={ ...cloudinarySettings,APP_ORIGIN:origin,ADDITIONAL_APP_ORIGINS:[legacy] };
let f,provider,storage;
before(async()=>{
  provider=cloudinaryFixture(); storage=createCloudinaryStorage(settings,provider.sdk,provider.fetchFile);
  f=await createFixture('m5hosting',settings,{ storage });
});
after(async()=>{ await f?.close(); });

test('Vercel builds the root monorepo, serves SPA routes and proxies exclusively to the existing Render API without functions or secrets',()=>{
  const config=JSON.parse(readFileSync(new URL('../vercel.json',import.meta.url)));
  assert.equal(config.buildCommand,'npm run build'); assert.equal(config.installCommand,'npm ci --include=dev'); assert.equal(config.outputDirectory,'apps/web/dist');
  const api=config.rewrites.find(rule=>rule.source==='/api/:path*');
  assert.equal(api.destination,'https://fieldsync-api-t5kg.onrender.com/api/:path*'); assert.equal(config.functions,undefined);
  assert.ok(!JSON.stringify(config).match(/DATABASE_URL|REDIS_URL|API_SECRET|SECRET_ACCESS_KEY/));
  const fallback=config.rewrites[1],match=new RegExp('^'+fallback.source+'$');
  assert.ok(match.test('/inspections/'+randomUUID())); assert.ok(match.test('/login'));
  for(const path of ['/api/v1/health','/api','/sw.js','/assets/missing.js','/favicon.svg']) assert.equal(match.test(path),false,path);
  const apiHeaders=config.headers.find(rule=>rule.source==='/api/:path*').headers;
  assert.ok(apiHeaders.some(header=>header.key==='x-vercel-enable-rewrite-caching'&&header.value==='0'));
  assert.ok(apiHeaders.some(header=>header.key==='Vercel-CDN-Cache-Control'&&header.value==='no-store'));
  const ignores=readFileSync(new URL('../.vercelignore',import.meta.url),'utf8');
  for(const entry of ['.env','.env.*','.local/','.codex/','.agents/']) assert.ok(ignores.split(/\r?\n/).includes(entry));
});

test('extra origins require exact URLs, production HTTPS and a bounded list; cookies remain secure and host-only for the same-origin proxy',()=>{
  const minimum={ ...cloudinarySettings,NODE_ENV:'production',APP_ORIGIN:origin,DATABASE_URL:'postgresql://test:synthetic@db.example.test/db',REDIS_URL:'redis://redis.example.test' };
  assert.equal(EnvironmentSchema.parse({ ...minimum,ADDITIONAL_APP_ORIGINS:legacy }).ADDITIONAL_APP_ORIGINS[0],legacy);
  for(const value of ['*','https://*.vercel.app','null','http://legacy.example.test','https://legacy.example.test/path',',',Array(6).fill(legacy).join(',')]) {
    assert.equal(EnvironmentSchema.safeParse({ ...minimum,ADDITIONAL_APP_ORIGINS:value }).success,false,value);
  }
  assert.deepEqual(cookieOptions({ NODE_ENV:'production',APP_ORIGIN:origin }),{ httpOnly:true,sameSite:'lax',path:'/',secure:true });
  assert.equal(cookieOptions({ NODE_ENV:'production',APP_ORIGIN:origin }).domain,undefined);
});

test('credentialed CORS answers strict preflights and exposes errors only to exact approved origins',async()=>{
  const app=createApp({ env:f.settings,logger:createLogger('silent'),getHealth:async()=>({ status:'ok',service:'fieldsync-api',timestamp:new Date().toISOString(),uptimeSeconds:1,
    dependencies:{ postgres:{ status:'up',latencyMs:1 },redis:{ status:'up',latencyMs:1 } } }) });
  for(const allowed of [origin,legacy]) {
    const response=await supertest(app).options('/api/v1/inspections/test').set('Origin',allowed).set('Access-Control-Request-Method','PUT')
      .set('Access-Control-Request-Headers','Content-Type, X-Amz-Meta-Sha256').expect(204);
    assert.equal(response.headers['access-control-allow-origin'],allowed); assert.equal(response.headers['access-control-allow-credentials'],'true');
    assert.ok(response.headers.vary.includes('Origin'));
    const health=await supertest(app).get('/api/v1/health').set('Origin',allowed).expect(200);
    assert.equal(health.headers['cache-control'],'no-store'); assert.equal(health.headers['access-control-allow-origin'],allowed);
  }
  for(const denied of ['null','https://preview-random.vercel.app','https://attacker.example.test']) {
    const response=await supertest(app).options('/api/v1/auth/login').set('Origin',denied).set('Access-Control-Request-Method','POST').expect(403);
    assert.equal(response.headers['access-control-allow-origin'],undefined);
    await supertest(app).get('/api/v1/health').set('Origin',denied).expect(403);
  }
  await supertest(app).options('/api/v1/health').expect(403);
  await supertest(app).options('/api/v1/health').set('Origin',origin).set('Access-Control-Request-Method','TRACE').expect(403);
  await supertest(app).options('/api/v1/health').set('Origin',origin).set('Access-Control-Request-Method','POST').set('Access-Control-Request-Headers','Authorization').expect(403);
});

test('approved primary and legacy origins retain login authorization and CSRF protections during cutover',async()=>{
  for(const allowed of [origin,legacy]) {
    const login=await supertest(f.server).post('/api/v1/auth/login').set('Origin',allowed).send({ organizationId:f.orgA.organization.id,email:f.workerA.user.email,password:f.password }).expect(200);
    const header=login.headers['set-cookie'][0];
    for(const attribute of [/HttpOnly/i,/Secure/i,/SameSite=Lax/i]) assert.ok(attribute.test(header));
    assert.equal(/Domain=/i.test(header),false);
    const cookie=header.split(';')[0];
    for(let index=0;index<2;index++) {
      const me=await supertest(f.server).get('/api/v1/auth/me').set('Origin',allowed).set('Cookie',cookie).expect(200);
      assert.equal(me.body.user.id,f.workerA.user.id);
    }
  }
  await supertest(f.server).post('/api/v1/auth/login').send({ organizationId:f.orgA.organization.id,email:f.workerA.user.email,password:f.password }).expect(403);
  await supertest(f.server).post('/api/v1/auth/login').set('Origin','https://attacker.example.test').send({}).expect(403);
});

test('Cloudinary upload descriptors use the validated requesting origin so Vercel and the retained Render shell both work',async()=>{
  for(const allowed of [origin,legacy]) {
    const row=await f.fresh(),hash=createHash('sha256').update(png).digest('hex');
    const file=(await f.send('post',`/inspections/${row.id}/evidence/reserve`,f.workerA,intent({ evidenceId:randomUUID(),name:'proxy.png',mimeType:'image/png',size:png.length,sha256:hash })).expect(201)).body;
    const response=await supertest(f.server).post(`/api/v1/inspections/${row.id}/evidence/${file.id}/upload`).set('Origin',allowed).set('Cookie',f.workerA.cookie).send({}).expect(200);
    const descriptor=response.body;
    assert.equal(new URL(descriptor.url).origin,allowed);
    await supertest(f.server).put(new URL(descriptor.url).pathname).set('Origin',allowed).set('Cookie',f.workerA.cookie).set(descriptor.headers).send(png).expect(204);
    await f.send('post',`/inspections/${row.id}/evidence`,f.workerA,intent({ evidenceId:file.id,baseVersion:row.version })).expect(200);
    const download=await supertest(f.server).get(`/api/v1/inspections/${row.id}/evidence/${file.id}/download`).set('Origin',allowed).set('Cookie',f.workerA.cookie).expect(200);
    assert.deepEqual(download.body,png);
    await f.send('post',`/inspections/${row.id}/evidence/remove`,f.workerA,intent({ evidenceId:file.id,baseVersion:2 })).expect(200);
  }
});
