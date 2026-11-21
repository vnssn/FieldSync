import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { createServer } from 'node:http';
import supertest from 'supertest';
import { Queue } from 'bullmq';
import { DeleteBucketCommand } from '@aws-sdk/client-s3';
import { env } from '../../apps/server/src/config/env.js';
import { createPool } from '../../apps/server/src/infrastructure/database.js';
import { runMigrations } from '../../apps/server/src/infrastructure/migrations.js';
import { createLogger } from '../../apps/server/src/infrastructure/logger.js';
import { createEvidenceStorage,ensureBucket } from '../../apps/server/src/infrastructure/storage.js';
import { redisConnection } from '../../apps/server/src/infrastructure/redis.js';
import { createApp } from '../../apps/server/src/app.js';
import { processJob,createJobRuntime } from '../../apps/server/src/modules/jobs/worker.js';
import { createHealthCheck } from '../../apps/server/src/modules/health/service.js';
import { uploadBlob } from '../../apps/web/src/offline/evidence.js';

export const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jKxkAAAAASUVORK5CYII=','base64');
export const wav=Buffer.alloc(46);
wav.write('RIFF'); wav.writeUInt32LE(38,4); wav.write('WAVEfmt ',8); wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22);
wav.writeUInt32LE(8000,24); wav.writeUInt32LE(16000,28); wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34); wav.write('data',36); wav.writeUInt32LE(2,40);
export const intent=(body={})=>({ ...body,mutationId:randomUUID() });
export function completeContent(row,text='Human-written inspection report') {
  return { reportText:text,answers:row.template.items.map((item)=>({ itemId:item.id,outcome:'pass',notes:'' })) };
}
export async function poll(check,label,timeout=15000) {
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline) { const result=await check(); if(result) return result; await new Promise((resolve)=>setTimeout(resolve,40)); }
  throw new Error(`Timed out waiting for ${label}`);
}
export async function createFixture(prefix='m5',extra={},options={}) {
  assert.match(prefix,/^m5[a-z]*$/);
  const id=randomUUID(),schema=`fieldsync_${prefix}_${id.replaceAll('-','')}`,bucket=`fieldsync-${prefix}-${id}`;
  const settings={ ...env,AI_ENABLED:false,AI_REPORT_PROVIDER:'openai',GROQ_API_KEY:'',AI_MAX_PER_HOUR:1000,AI_RATE_LIMIT:1000,AUTH_RATE_LIMIT:1000,S3_BUCKET:bucket,QUEUE_PREFIX:schema,...extra };
  const origin=new URL(settings.APP_ORIGIN).origin,logger=createLogger('silent'),directories=new Map(),password='M5-integration-password-27';
  let pool,adminPool,storage,server,bucketCreated=false;
  const fixture={ schema,bucket,settings,origin,logger,directories,password,
    send(method,path,actor,body) {
      let request=supertest(server)[method](`/api/v1${path}`).set('Origin',origin);
      if(actor) request=request.set('Cookie',actor.cookie);
      return body===undefined ? request:request.send(body);
    },
    async organization(name) {
      const response=await fixture.send('post','/auth/register-org',null,{ organizationName:name,name:'Admin',email:'admin@example.test',password }).expect(201);
      const owner={ ...response.body,cookie:response.headers['set-cookie'][0].split(';')[0] };
      const asset=(await fixture.send('post','/assets',owner,{ code:`PUMP-${randomUUID().slice(0,8)}`,name:'Pump',category:'Equipment',location:'Yard' }).expect(201)).body;
      const template=(await fixture.send('post','/templates',owner,intent({ name:'Safety',description:'Check actual equipment',items:[{ id:randomUUID(),label:'Pressure' },{ id:randomUUID(),label:'Leaks' }] })).expect(201)).body;
      directories.set(owner.organization.id,{ asset,template }); return owner;
    },
    async worker(owner,email=`worker-${randomUUID()}@example.test`) {
      const user=(await fixture.send('post','/users',owner,{ name:'Worker',email,password }).expect(201)).body;
      const login=await fixture.send('post','/auth/login',null,{ organizationId:owner.organization.id,email,password }).expect(200);
      return { user,organization:owner.organization,cookie:login.headers['set-cookie'][0].split(';')[0] };
    },
    async fresh(owner=fixture.orgA,actor=fixture.workerA) {
      const directory=directories.get(owner.organization.id);
      return (await fixture.send('post','/inspections',owner,intent({ assetId:directory.asset.id,templateId:directory.template.id,assignedTo:actor.user.id })).expect(201)).body;
    },
    async detail(row,actor=fixture.workerA) { return (await fixture.send('get',`/inspections/${row.id}`,actor).expect(200)).body; },
    async attach(row,{ bytes=png,mimeType='image/png',name='field.png',actor=fixture.workerA,ready=true }={}) {
      const body=intent({ evidenceId:randomUUID(),name,mimeType,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex') });
      const evidence=(await fixture.send('post',`/inspections/${row.id}/evidence/reserve`,actor,body).expect(201)).body;
      const descriptor=(await fixture.send('post',`/inspections/${row.id}/evidence/${evidence.id}/upload`,actor,{}).expect(200)).body;
      await uploadBlob(descriptor,new Blob([bytes],{ type:mimeType }));
      const inspection=(await fixture.send('post',`/inspections/${row.id}/evidence`,actor,intent({ evidenceId:evidence.id,baseVersion:row.version })).expect(200)).body;
      const metadata=(await pool.query('SELECT * FROM evidence WHERE organization_id=$1 AND inspection_id=$2 AND id=$3',[row.organizationId,row.id,evidence.id])).rows[0];
      if(ready) {
        const job=(await pool.query("SELECT * FROM background_jobs WHERE organization_id=$1 AND inspection_id=$2 AND evidence_id=$3 AND kind='verify_evidence'",[row.organizationId,row.id,evidence.id])).rows[0];
        await fixture.run(job);
      }
      return { inspection,evidence,metadata,bytes };
    },
    async request(row,kind='report',evidenceId=null,actor=fixture.workerA,body=intent({ kind,evidenceId,baseVersion:row.version })) {
      return (await fixture.send('post',`/inspections/${row.id}/ai`,actor,body).expect(201)).body;
    },
    async artifact(row,id,actor=fixture.workerA) {
      return (await fixture.send('get',`/inspections/${row.id}/ai`,actor).expect(200)).body.artifacts.find((item)=>item.id===id);
    },
    async job(artifact) { return (await pool.query('SELECT * FROM background_jobs WHERE organization_id=$1 AND inspection_id=$2 AND ai_artifact_id=$3',[artifact.organizationId,artifact.inspectionId,artifact.id])).rows[0]; },
    async run(job,aiProvider) { return processJob({ pool,storage,aiProvider },{ organizationId:job.organization_id,jobId:job.id }); },
    async ready(row,kind='report',evidenceId=null,actor=fixture.workerA,aiProvider) {
      const artifact=await fixture.request(row,kind,evidenceId,actor); await fixture.run(await fixture.job(artifact),aiProvider);
      return fixture.artifact(row,artifact.id,actor);
    },
    async runtime(work,aiProvider) {
      const runtime=createJobRuntime({ pool,storage,env:settings,logger,aiProvider,intervalMs:50 });
      try { await runtime.queue.waitUntilReady(); return await work(runtime); } finally { await runtime.close(); }
    },
    async close() {
      try {
        if(server?.listening) await new Promise((resolve)=>{ server.close(resolve); server.closeAllConnections(); });
        const queue=new Queue('fieldsync-jobs',{ connection:{ ...redisConnection(settings),maxRetriesPerRequest:1 },prefix:schema });
        try { await queue.obliterate({ force:true }); } finally { await queue.close(); }
        if(bucketCreated) { for await(const object of storage.objects()) await storage.remove(object.Key); await storage.client.send(new DeleteBucketCommand({ Bucket:bucket })); }
      } finally {
        storage?.client.destroy(); await pool?.end();
        if(adminPool) { try { assert.match(schema,/^fieldsync_m5[a-z]*_[a-f0-9]{32}$/); await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await adminPool.end(); } }
      }
    },
  };
  try {
    adminPool=createPool(env); await adminPool.query(`CREATE SCHEMA "${schema}"`);
    pool=createPool(env,{ schema }); await runMigrations(pool,{ info() {},warn() {},error() {} },schema);
    storage=options.storage ?? createEvidenceStorage(settings);
    if (!options.storage) { await ensureBucket(storage.client,bucket,settings.S3_REGION); bucketCreated=true; }
    server=createServer(createApp({ pool,storage,env:settings,logger,getHealth:createHealthCheck({ pool,env:settings,logger }),webDirectory:options.webDirectory }));
    await new Promise((resolve,reject)=>{ server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
    Object.assign(fixture,{ pool,adminPool,storage,server });
    fixture.orgA=await fixture.organization('M5 A'); fixture.orgB=await fixture.organization('M5 B');
    fixture.workerA=await fixture.worker(fixture.orgA); fixture.workerA2=await fixture.worker(fixture.orgA); fixture.workerB=await fixture.worker(fixture.orgB);
    return fixture;
  } catch(error) { await fixture.close(); throw error; }
}
