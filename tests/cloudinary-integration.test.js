import test,{ before,after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import supertest from 'supertest';
import { createFixture,png,wav,intent } from './helpers/m5.js';
import { cloudinaryFixture,cloudinarySettings } from './helpers/cloudinary.js';
import { createCloudinaryStorage } from '../apps/server/src/infrastructure/cloudinary-storage.js';
import { reconcileObjects } from '../apps/server/src/modules/jobs/worker.js';
import { createEvidenceService } from '../apps/server/src/modules/evidence/service.js';
import { Readable,Writable } from 'node:stream';

let f,provider,storage;
before(async()=>{
  provider=cloudinaryFixture(); storage=createCloudinaryStorage(cloudinarySettings,provider.sdk,provider.fetchFile);
  f=await createFixture('m5cloudinary',cloudinarySettings,{ storage });
});
after(async()=>{ await f?.close(); });
const checksum=(bytes)=>createHash('sha256').update(bytes).digest('hex');
const path=(row,id)=>`/inspections/${row.id}/evidence/${id}`;
async function reserve(row,bytes=png,mimeType='image/png') {
  const body=intent({ evidenceId:randomUUID(),name:'evidence',mimeType,size:bytes.length,sha256:checksum(bytes) });
  const evidence=(await f.send('post',`/inspections/${row.id}/evidence/reserve`,f.workerA,body).expect(201)).body;
  const descriptor=(await f.send('post',`${path(row,evidence.id)}/upload`,f.workerA,{}).expect(200)).body;
  return { row,evidence,descriptor,bytes };
}
function put(file,actor=f.workerA,options={}) {
  let request=supertest(f.server).put(new URL(options.url??file.descriptor.url).pathname)
    .set('Origin',options.origin??f.origin).set(file.descriptor.headers);
  if(actor) request=request.set('Cookie',actor.cookie);
  if(options.headers) request=request.set(options.headers);
  return request.send(options.bytes??file.bytes);
}
async function metadata(file) {
  return (await f.pool.query('SELECT * FROM evidence WHERE organization_id=$1 AND inspection_id=$2 AND id=$3',[file.row.organizationId,file.row.id,file.evidence.id])).rows[0];
}
async function attach(file,body=intent({ evidenceId:file.evidence.id,baseVersion:file.row.version })) {
  return (await f.send('post',`/inspections/${file.row.id}/evidence`,f.workerA,body).expect(200)).body;
}
async function job(file,kind) {
  return (await f.pool.query('SELECT * FROM background_jobs WHERE organization_id=$1 AND inspection_id=$2 AND evidence_id=$3 AND kind=$4 ORDER BY created_at DESC',
    [file.row.organizationId,file.row.id,file.evidence.id,kind])).rows[0];
}

test('proxy authenticates sessions, tenants, assignment, creator and origin before any provider write',async()=>{
  const row=await f.fresh(),file=await reserve(row),writes=()=>provider.calls.filter((call)=>call.action==='upload').length,count=writes();
  await put(file,null).expect(401);
  for(const actor of [f.workerB,f.workerA2]) await put(file,actor).expect(404);
  await put(file,f.orgA).expect(403);
  await put(file,f.workerA,{ origin:'https://foreign.example.test' }).expect(403);
  const other=await f.fresh(),otherUrl=new URL(file.descriptor.url); otherUrl.pathname=otherUrl.pathname.replace(row.id,other.id);
  await put(file,f.workerA,{ url:otherUrl.href }).expect(404);
  const badUrl=new URL(file.descriptor.url); badUrl.pathname=badUrl.pathname.replace(/[^/]+$/,randomUUID());
  await put(file,f.workerA,{ url:badUrl.href }).expect(410);
  assert.equal(writes(),count);
  // The binary exception cannot remove JSON checks on unrelated mutations.
  await supertest(f.server).put(`/api/v1/inspections/${row.id}`).set('Origin',f.origin).set('Cookie',f.workerA.cookie).set('Content-Type','image/png').send(png).expect(415);
  await supertest(f.server).post(`/api/v1/inspections/${row.id}/evidence/reserve`).set('Origin',f.origin).set('Cookie',f.workerA.cookie).set('Content-Type','image/png').send(png).expect(415);
});

test('proxy rejects incorrect MIME, metadata, length, file signature and hash before storing bytes',async()=>{
  const file=await reserve(await f.fresh()),count=provider.calls.filter((call)=>call.action==='upload').length;
  for(const options of [{ headers:{ 'Content-Type':'image/jpeg' } },{ headers:{ 'x-amz-meta-sha256':'0'.repeat(64) } },
    { headers:{ 'Content-Encoding':'gzip' } },{ bytes:Buffer.concat([png,Buffer.alloc(1)]) },{ bytes:png.subarray(0,8) }]) await put(file,f.workerA,options).expect(400);
  const changed=Buffer.from(png); changed[changed.length-1]^=1; await put(file,f.workerA,{ bytes:changed }).expect(400);
  const invalid=await reserve(await f.fresh(),Buffer.from('not a PNG')); await put(invalid).expect(400);
  assert.equal(provider.calls.filter((call)=>call.action==='upload').length,count);
});

test('authorization is rechecked after bytes arrive, so reassignment during upload prevents provider writes',async()=>{
  const file=await reserve(await f.fresh()),row=await metadata(file),count=provider.calls.filter((call)=>call.action==='upload').length;
  const stream=Readable.from((async function*() {
    await f.pool.query('UPDATE inspections SET assigned_to=$3,worker_snapshot=$4::jsonb WHERE organization_id=$1 AND id=$2',
      [file.row.organizationId,file.row.id,f.workerA2.user.id,JSON.stringify({ id:f.workerA2.user.id,name:f.workerA2.user.name,email:f.workerA2.user.email })]);
    yield png;
  })());
  stream.get=(name)=>({ 'content-type':row.mime_type,'content-length':String(row.size),'x-amz-meta-sha256':row.sha256 })[name];
  const service=createEvidenceService(f.pool,storage,f.logger);
  await assert.rejects(service.uploadContent({ organizationId:file.row.organizationId,user:f.workerA.user },file.row.id,file.evidence.id,row.staging_key.split('/').at(-1),stream),{ code:'INSPECTION_NOT_FOUND' });
  assert.equal(provider.calls.filter((call)=>call.action==='upload').length,count);
});

test('provider failures return a generic error without exposing credentials or private URLs',async(t)=>{
  const file=await reserve(await f.fresh());
  t.mock.method(provider.sdk.uploader,'upload_stream',(_options,callback)=>new Writable({
    write(_chunk,_encoding,done) { done(); },final(done) { callback(new Error('private-provider-detail https://private.example.test/?secret=synthetic')); done(); },
  }));
  const response=await put(file).expect(500);
  assert.equal(response.body.error.code,'INTERNAL_ERROR'); assert.doesNotMatch(JSON.stringify(response.body),/private-provider-detail|secret=|cloudinary|api_key|api_secret/);
});

test('photo and audio attach, worker verification, private downloads, receipt replay and authorized deletion use Cloudinary',async()=>{
  for(const [bytes,mime] of [[png,'image/png'],[wav,'audio/wav']]) {
    const file=await reserve(await f.fresh(),bytes,mime); await put(file).expect(204); await put(file).expect(204);
    const body=intent({ evidenceId:file.evidence.id,baseVersion:file.row.version }),attached=await attach(file,body);
    assert.deepEqual(await attach(file,body),attached);
    await f.run(await job(file,'verify_evidence'));
    assert.equal((await metadata(file)).processing_status,'ready');
    for(const actor of [f.workerA,f.orgA]) {
      const response=await f.send('get',`${path(file.row,file.evidence.id)}/download`,actor).expect(200);
      assert.deepEqual(response.body,bytes); assert.equal(response.headers['cache-control'],'no-store');
      assert.equal(response.headers['cross-origin-resource-policy'],'same-origin'); assert.equal(response.headers.location,undefined);
      assert.ok(!JSON.stringify(response.headers).includes('cloudinary'));
    }
    for(const actor of [f.workerB,f.workerA2]) {
      await f.send('get',`${path(file.row,file.evidence.id)}/download`,actor).expect(404);
      await f.send('post',`/inspections/${file.row.id}/evidence/remove`,actor,intent({ evidenceId:file.evidence.id,baseVersion:attached.version })).expect(404);
    }
    await f.send('post',`/inspections/${file.row.id}/evidence/remove`,f.orgA,intent({ evidenceId:file.evidence.id,baseVersion:attached.version })).expect(403);
    await f.send('post',`/inspections/${file.row.id}/evidence/remove`,f.workerA,intent({ evidenceId:file.evidence.id,baseVersion:1 })).expect(409);
    await put(file).expect(409);
    const removed=(await f.send('post',`/inspections/${file.row.id}/evidence/remove`,f.workerA,intent({ evidenceId:file.evidence.id,baseVersion:attached.version })).expect(200)).body;
    assert.equal(removed.evidence.length,0); await f.run(await job(file,'cleanup_evidence'));
    await f.send('get',`${path(file.row,file.evidence.id)}/download`,f.workerA).expect(404);
    const row=await metadata(file); assert.equal(provider.assets.has(`fieldsync-test/${row.object_key}`),false); assert.equal(provider.assets.has(`fieldsync-test/${row.staging_key}`),false);
  }
});

test('expired generations renew onto a new key; old cleanup cannot delete current uploads',async()=>{
  const file=await reserve(await f.fresh()); await put(file).expect(204); const previous=await metadata(file);
  await f.pool.query('UPDATE evidence SET expires_at=now()-interval \'1 second\' WHERE organization_id=$1 AND id=$2',[file.row.organizationId,file.evidence.id]);
  await put(file).expect(410);
  const next=(await f.send('post',`${path(file.row,file.evidence.id)}/upload`,f.workerA,{}).expect(200)).body;
  await put(file).expect(410); await put({ ...file,descriptor:next }).expect(204);
  const current=await metadata(file); assert.notEqual(current.staging_key,previous.staging_key);
  const oldJob=(await f.pool.query("UPDATE background_jobs SET run_after=now() WHERE organization_id=$1 AND evidence_id=$2 AND payload->>'key'=$3 RETURNING *",[file.row.organizationId,file.evidence.id,previous.staging_key])).rows[0];
  await f.run(oldJob);
  assert.equal(provider.assets.has(`fieldsync-test/${previous.staging_key}`),false); assert.equal(provider.assets.has(`fieldsync-test/${current.staging_key}`),true);
  await attach({ ...file,descriptor:next });
});

test('read-only states and creator changes fail closed; Cloudinary sweeper reaps only old unreferenced objects',async()=>{
  const file=await reserve(await f.fresh());
  await f.pool.query("UPDATE inspections SET status='cancelled' WHERE organization_id=$1 AND id=$2",[file.row.organizationId,file.row.id]);
  await put(file).expect(409);
  const changed=await reserve(await f.fresh());
  await f.pool.query('UPDATE evidence SET created_by=$3 WHERE organization_id=$1 AND id=$2',[changed.row.organizationId,changed.evidence.id,f.workerA2.user.id]);
  await put(changed).expect(409);
  const kept=await reserve(await f.fresh()); await put(kept).expect(204); await attach(kept);
  const source=await metadata(kept),orphan=await storage.promote(source),recent=await storage.promote(source);
  for(const asset of provider.assets.values()) asset.created_at=new Date(Date.now()-7200000).toISOString();
  provider.assets.get(`fieldsync-test/${recent}`).created_at=new Date().toISOString();
  provider.assets.set(`fieldsync-other/${orphan}`,{ bytes:png,created_at:new Date(0).toISOString() });
  await reconcileObjects(f.pool,storage);
  assert.equal(provider.assets.has(`fieldsync-test/${source.object_key}`),true); assert.equal(provider.assets.has(`fieldsync-test/${source.staging_key}`),true);
  assert.equal(provider.assets.has(`fieldsync-test/${orphan}`),false); assert.equal(provider.assets.has(`fieldsync-test/${recent}`),true); assert.equal(provider.assets.has(`fieldsync-other/${orphan}`),true);
  const shell=await supertest(f.server).get('/api/v1/health').expect(200);
  assert.match(shell.headers['content-security-policy'],/connect-src 'self';/); assert.doesNotMatch(shell.headers['content-security-policy'],/cloudinary|minio|9000/);
});
