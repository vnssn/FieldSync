import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Queue } from 'bullmq';
import { GetObjectCommand,PutObjectCommand,DeleteBucketCommand } from '@aws-sdk/client-s3';
import { createFixture,intent,completeContent,poll } from './helpers/m5.js';
import { createPool } from '../apps/server/src/infrastructure/database.js';
import { createEvidenceStorage,ensureBucket } from '../apps/server/src/infrastructure/storage.js';
import { redisConnection } from '../apps/server/src/infrastructure/redis.js';
import { createJobRuntime } from '../apps/server/src/modules/jobs/worker.js';

function postgresTool(args,input) {
  return new Promise((resolve,reject)=>{
    const child=spawn('docker',['compose','exec','-T','postgres',...args],{ stdio:['pipe','pipe','pipe'],windowsHide:true });
    const output=[],errors=[];
    child.stdout.on('data',(chunk)=>output.push(chunk)); child.stderr.on('data',(chunk)=>errors.push(chunk));
    child.on('error',reject); child.on('close',(code)=>code===0?resolve(Buffer.concat(output)):reject(new Error(`PostgreSQL backup tool exited ${code}: ${Buffer.concat(errors).toString('utf8')}`)));
    child.stdin.on('error',()=>{}); child.stdin.end(input);
  });
}

test('M5 real pg_dump/pg_restore, private MinIO recovery and Redis reconciliation preserve reviewed data, provenance and receipts',async()=>{
  const f=await createFixture('m5restore'),target=`fieldsync_restore_${randomUUID().replaceAll('-','')}`;
  const bucket=`fieldsync-m5restored-${randomUUID()}`,prefix=`${f.schema}-target`;
  let restored,storage,runtime,created=false,bucketCreated=false;
  try {
    assert.ok(['127.0.0.1','localhost'].includes(f.settings.POSTGRES_HOST),'The restore exercise is restricted to local Compose PostgreSQL');
    const file=await f.attach(await f.fresh()),artifact=await f.ready(file.inspection);
    const review=intent({ decision:'apply',confirmed:true,baseVersion:2,...completeContent(file.inspection,'Human-reviewed report restored from backup') });
    const applied=(await f.send('post',`/inspections/${file.inspection.id}/ai/${artifact.id}/review`,f.workerA,review).expect(200)).body;
    const submit=intent({ baseVersion:3,...completeContent(applied,applied.reportText) });
    const submitted=(await f.send('post',`/inspections/${applied.id}/submit`,f.workerA,submit).expect(200)).body;
    const original=(await f.pool.query('SELECT * FROM ai_artifacts WHERE organization_id=$1 AND id=$2',[submitted.organizationId,artifact.id])).rows[0];
    const started=Date.now();
    const dump=await postgresTool(['pg_dump','--username',f.settings.POSTGRES_USER,'--dbname',f.settings.POSTGRES_DB,'--format=custom','--no-owner','--no-privileges','--schema',f.schema]);
    assert.ok(dump.length>0); assert.match(target,/^fieldsync_restore_[a-f0-9]{32}$/);
    await f.adminPool.query(`CREATE DATABASE "${target}"`); created=true;
    await postgresTool(['pg_restore','--username',f.settings.POSTGRES_USER,'--dbname',target,'--exit-on-error','--no-owner','--no-privileges'],dump);
    const url=f.settings.DATABASE_URL?new URL(f.settings.DATABASE_URL):null; if(url) url.pathname=`/${target}`;
    const settings={ ...f.settings,POSTGRES_DB:target,DATABASE_URL:url?.toString(),S3_BUCKET:bucket,QUEUE_PREFIX:prefix };
    restored=createPool(settings,{ schema:f.schema });
    storage=createEvidenceStorage(settings); await ensureBucket(storage.client,bucket,settings.S3_REGION); bucketCreated=true;
    // Recover immutable attached objects into a new private bucket. Expiring
    // staging uploads are not claimed to survive a server-side backup.
    for await(const object of f.storage.objects()) {
      if(!object.Key.includes('/verified/')) continue;
      const source=await f.storage.client.send(new GetObjectCommand({ Bucket:f.bucket,Key:object.Key }));
      const bytes=await source.Body.transformToByteArray();
      await storage.client.send(new PutObjectCommand({ Bucket:bucket,Key:object.Key,Body:bytes,ContentType:source.ContentType,Metadata:source.Metadata,IfNoneMatch:'*' }));
    }
    const metadata=(await restored.query('SELECT * FROM evidence WHERE organization_id=$1 AND inspection_id=$2 AND id=$3',[submitted.organizationId,submitted.id,file.evidence.id])).rows[0];
    assert.deepEqual(await storage.read(metadata.object_key,metadata),file.bytes);
    const recovered=(await restored.query('SELECT * FROM ai_artifacts WHERE organization_id=$1 AND id=$2',[submitted.organizationId,artifact.id])).rows[0];
    assert.deepEqual(recovered.original_output,original.original_output); assert.equal(recovered.raw_output,original.raw_output); assert.equal(recovered.source_version,2);
    const confirmed=(await restored.query('SELECT * FROM ai_reviews WHERE organization_id=$1 AND artifact_id=$2',[submitted.organizationId,artifact.id])).rows[0];
    assert.equal(confirmed.confirmed_output.reportText,applied.reportText); assert.equal(confirmed.applied_version,3);
    assert.equal((await restored.query('SELECT snapshot FROM inspection_revisions WHERE organization_id=$1 AND inspection_id=$2 AND version=4',[submitted.organizationId,submitted.id])).rows[0].snapshot.aiSources[0].artifactId,artifact.id);
    assert.equal((await restored.query('SELECT 1 FROM mutation_receipts WHERE organization_id=$1 AND user_id=$2 AND mutation_id=$3',[submitted.organizationId,f.workerA.user.id,review.mutationId])).rowCount,1);
    assert.equal((await restored.query('SELECT count(*)::int AS n FROM pgmigrations')).rows[0].n,5);
    runtime=createJobRuntime({ pool:restored,storage,env:settings,logger:f.logger,intervalMs:50 });
    await poll(async()=> (await restored.query("SELECT status FROM background_jobs WHERE organization_id=$1 AND inspection_id=$2 AND kind='prepare_report'",[submitted.organizationId,submitted.id])).rows[0]?.status==='completed','restored report intent');
    const archive=(await restored.query("SELECT result FROM background_jobs WHERE organization_id=$1 AND inspection_id=$2 AND kind='prepare_report'",[submitted.organizationId,submitted.id])).rows[0].result;
    assert.equal(archive.sourceVersion,4); assert.match(archive.html,/Human-reviewed report restored from backup/);
    console.log(`M5 restore: custom PostgreSQL dump ${dump.length} bytes, verified MinIO bytes and SQL job reconciliation recovered in ${Date.now()-started}ms using disposable local targets.`);
  } finally {
    await runtime?.close();
    const queue=new Queue('fieldsync-jobs',{ connection:{ ...redisConnection(f.settings),maxRetriesPerRequest:1 },prefix });
    try { await queue.obliterate({ force:true }); } finally { await queue.close(); }
    try {
      if(bucketCreated) { for await(const object of storage.objects()) await storage.remove(object.Key); await storage.client.send(new DeleteBucketCommand({ Bucket:bucket })); }
    } finally {
      storage?.client.destroy(); await restored?.end();
      if(created) { assert.match(target,/^fieldsync_restore_[a-f0-9]{32}$/); await f.adminPool.query(`DROP DATABASE "${target}" WITH (FORCE)`); }
      await f.close();
    }
  }
});
