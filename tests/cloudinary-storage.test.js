import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { EnvironmentSchema } from '../apps/server/src/config/schema.js';
import { createPool } from '../apps/server/src/infrastructure/database.js';
import { createCloudinaryStorage } from '../apps/server/src/infrastructure/cloudinary-storage.js';
import { evidencePrefix,readEvidenceBytes } from '../apps/server/src/infrastructure/storage.js';
import { uploadBlob } from '../apps/web/src/offline/evidence.js';
import { cloudinaryFixture,cloudinarySettings } from './helpers/cloudinary.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jKxkAAAAASUVORK5CYII=','base64');
const hash=(bytes)=>createHash('sha256').update(bytes).digest('hex');
function row(bytes=png,mime_type='image/png') {
  const organization_id=randomUUID(),inspection_id=randomUUID(),id=randomUUID();
  return { organization_id,inspection_id,id,mime_type,size:bytes.length,sha256:hash(bytes),expires_at:new Date(Date.now()+1200000),
    staging_key:`${evidencePrefix(organization_id,inspection_id,id)}/staging/${randomUUID()}` };
}
function fixture() { const f=cloudinaryFixture(); return { ...f,storage:createCloudinaryStorage(cloudinarySettings,f.sdk,f.fetchFile) }; }

test('Cloudinary production validation ignores inactive S3 values, requires cloud credentials and exact HTTPS origin',()=>{
  const minimum={ ...cloudinarySettings,NODE_ENV:'production',DATABASE_URL:'postgresql://user:pass@ep-demo-pooler.region.aws.neon.tech/db',
    MIGRATIONS_DATABASE_URL:'postgresql://user:pass@ep-demo.region.aws.neon.tech/db',REDIS_URL:'redis://redis.example.test',POSTGRES_SSL:'true',
    S3_ENDPOINT:'invalid',S3_PUBLIC_ENDPOINT:'invalid',S3_ACCESS_KEY_ID:'',S3_SECRET_ACCESS_KEY:'' };
  assert.equal(EnvironmentSchema.safeParse(minimum).success,true);
  for (const key of ['CLOUDINARY_CLOUD_NAME','CLOUDINARY_API_KEY','CLOUDINARY_API_SECRET','CLOUDINARY_FOLDER','MIGRATIONS_DATABASE_URL']) {
    assert.equal(EnvironmentSchema.safeParse({ ...minimum,[key]:'' }).success,false,key);
  }
  for (const APP_ORIGIN of ['', 'not-a-url','http://fieldsync.example.test','https://fieldsync.example.test/path','https://user:pass@fieldsync.example.test','https://fieldsync.example.test?query=1','https://fieldsync.example.test#fragment']) {
    assert.equal(EnvironmentSchema.safeParse({ ...minimum,APP_ORIGIN }).success,false);
  }
  assert.equal(EnvironmentSchema.safeParse({ ...minimum,EVIDENCE_STORAGE_PROVIDER:'unknown' }).success,false);
  assert.equal(EnvironmentSchema.safeParse({ ...minimum,CLOUDINARY_FOLDER:'../another-deployment' }).success,false);
});

test('database pools preserve pooled runtime URL, direct migration override and verified TLS',async()=>{
  const settings={ DATABASE_URL:'postgresql://user:pass@ep-demo-pooler.region.aws.neon.tech/db?sslmode=no-verify',POSTGRES_SSL:true };
  const runtime=createPool(settings),migration=createPool(settings,{ databaseUrl:'postgresql://user:pass@ep-demo.region.aws.neon.tech/db?sslmode=require' });
  try {
    assert.match(runtime.options.connectionString,/-pooler\./); assert.doesNotMatch(migration.options.connectionString,/-pooler\./);
    assert.doesNotMatch(runtime.options.connectionString,/sslmode/); assert.equal(runtime.options.ssl.rejectUnauthorized,true);
    assert.equal(migration.options.ssl.rejectUnauthorized,true); assert.equal(runtime.options.options,undefined);
  } finally { await runtime.end(); await migration.end(); }
});

test('Cloudinary descriptors expose only same-origin session upload, bound metadata, expiry and generation',async()=>{
  const { storage,calls }=fixture(),file=row(),upload=await storage.presign(file);
  assert.equal(upload.transport,'server'); assert.equal(new URL(upload.url).origin,cloudinarySettings.APP_ORIGIN);
  assert.ok(upload.url.endsWith(file.staging_key.split('/').at(-1))); assert.equal(upload.headers['x-amz-meta-sha256'],file.sha256);
  assert.ok(new Date(upload.expiresAt)<=file.expires_at); assert.equal(calls.length,0);
  assert.ok(!JSON.stringify(upload).includes(cloudinarySettings.CLOUDINARY_API_SECRET)); assert.ok(!JSON.stringify(upload).includes(cloudinarySettings.CLOUDINARY_API_KEY));
  await assert.rejects(storage.presign({ ...file,expires_at:new Date(0) }),{ code:'UPLOAD_EXPIRED' });
  await assert.rejects(storage.presign({ ...file,staging_key:row().staging_key }),{ code:'INVALID_STORAGE_KEY' });
});

test('Cloudinary writes authenticated immutable raw bytes, reads privately, promotes a verified buffer and deletes idempotently',async()=>{
  const { storage,assets,calls }=fixture(),file=row();
  await storage.upload(file,png); await storage.upload(file,png);
  const key=await storage.promote(file); assert.match(key,/\/verified\//);
  assert.deepEqual(await storage.read(key,{ ...file,object_key:key }),png);
  const writes=calls.filter((call)=>call.action==='upload');
  for (const { options } of writes) {
    assert.equal(options.type,'authenticated'); assert.equal(options.resource_type,'raw'); assert.equal(options.overwrite,false);
    assert.equal(options.secure,true); assert.ok(options.public_id.startsWith('fieldsync-test/org/'));
  }
  assert.equal(calls.find((call)=>call.action==='download').options.type,'authenticated');
  assert.equal(calls.find((call)=>call.action==='fetch').options.redirect,'error');
  await storage.remove(file.staging_key); await storage.remove(key); await storage.remove(key); assert.equal(assets.size,0);
  assert.equal(calls.find((call)=>call.action==='delete').options.invalidate,true);
  await assert.rejects(storage.remove('other-deployment/file'),{ code:'INVALID_STORAGE_KEY' });
});

test('invalid size, hash, MIME signature, expired or foreign keys never cause Cloudinary uploads; private reads reject tampering',async()=>{
  const { storage,assets,calls }=fixture(),file=row();
  for (const change of [{ size:png.length+1 },{ sha256:'0'.repeat(64) },{ mime_type:'image/jpeg' },{ staging_key:row().staging_key },{ expires_at:new Date(0) }]) {
    await assert.rejects(storage.upload({ ...file,...change },png));
  }
  assert.equal(calls.length,0);
  await assert.rejects(storage.read(file.staging_key,file),{ code:'UPLOAD_MISSING' });
  await storage.upload(file,png);
  const changed=Buffer.from(png); changed[changed.length-1]^=1;
  assets.get(`fieldsync-test/${file.staging_key}`).bytes=changed;
  await assert.rejects(storage.read(file.staging_key,file),{ code:'INVALID_FILE' });
  const uploadCount=calls.filter((call)=>call.action==='upload').length;
  await assert.rejects(storage.promote(file),{ code:'INVALID_FILE' });
  assert.equal(calls.filter((call)=>call.action==='upload').length,uploadCount);
  await assert.rejects(storage.read(row().staging_key,file),{ code:'INVALID_STORAGE_KEY' });
});

test('Cloudinary verifies audio bytes without transformations and limits enumeration to its own namespace across pages',async()=>{
  const { storage,assets,calls }=fixture(),wav=Buffer.from('RIFF1234WAVEfixture'),file=row(wav,'audio/wav');
  await storage.upload(file,wav); await storage.promote(file); await storage.promote(file);
  assets.set(`fieldsync-other/${file.staging_key}`,{ bytes:wav,created_at:new Date().toISOString() });
  await storage.verify(); const listed=[]; for await (const asset of storage.objects()) listed.push(asset);
  assert.equal(listed.length,3); assert.ok(listed.every((asset)=>asset.Key.startsWith('org/') && asset.LastModified instanceof Date));
  assert.ok(calls.filter((call)=>call.action==='list').every((call)=>call.options.prefix==='fieldsync-test/org/'));
  await assert.rejects(async()=>{ for await(const _ of storage.objects('../')) {} },{ code:'INVALID_STORAGE_KEY' });
});

test('stream verification bounds chunked uploads, rejects truncation and enforces its deadline',async()=>{
  const file=row(); assert.deepEqual(await readEvidenceBytes(Readable.from([png.subarray(0,9),png.subarray(9)]),file),png);
  await assert.rejects(readEvidenceBytes(Readable.from([png,Buffer.alloc(1)]),file),{ code:'INVALID_FILE' });
  await assert.rejects(readEvidenceBytes(Readable.from([png.subarray(0,9)]),file),{ code:'INVALID_FILE' });
  const stalled=new Readable({ read() {} });
  try { await assert.rejects(readEvidenceBytes(stalled,file,20),{ code:'UPLOAD_TIMEOUT' }); } finally { stalled.destroy(); }
});

test('browser sends session credentials only for validated same-origin proxy descriptors and preserves failed Blobs',async(t)=>{
  const { storage }=fixture(),upload=await storage.presign(row()),blob=new Blob([png],{ type:'image/png' }),calls=[];
  const previous=globalThis.location; globalThis.location={ origin:cloudinarySettings.APP_ORIGIN };
  t.mock.method(globalThis,'fetch',async(...args)=>{ calls.push(args); return { ok:true }; });
  try {
    await uploadBlob(upload,blob); assert.equal(calls[0][1].credentials,'same-origin'); assert.equal(calls[0][1].body,blob);
    await assert.rejects(uploadBlob({ ...upload,url:'https://foreign.example.test/file' },blob),/current application origin/);
    assert.equal(calls.length,1); assert.deepEqual(Buffer.from(await blob.arrayBuffer()),png);
  } finally { if(previous===undefined) delete globalThis.location; else globalThis.location=previous; }
});
