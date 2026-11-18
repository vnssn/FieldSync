import test,{ before,after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { createFixture,intent,completeContent,poll,png,wav } from './helpers/m5.js';
import { createAiProvider, fallbackAssistance } from '../apps/server/src/modules/ai/provider.js';
import { recoverExpiredJobs } from '../apps/server/src/modules/jobs/worker.js';
import { publicInspection } from '../apps/server/src/modules/inspections/repository.js';

let f;
before(async()=>{ f=await createFixture(); });
after(async()=>{ await f?.close(); });
const reviewBody=(row,extra={})=>intent({ decision:'apply',confirmed:true,baseVersion:row.version,...completeContent(row),...extra });
function review(row,artifact,body=reviewBody(row),actor=f.workerA) {
  return f.send('post',`/inspections/${row.id}/ai/${artifact.id}/review`,actor,body);
}

test('M5 artifact, evidence, revision, reviewer and job FKs reject cross-tenant and cross-inspection references',async()=>{
  const a=await f.fresh(),b=await f.fresh(f.orgB,f.workerB),other=await f.fresh();
  const file=await f.attach(other);
  const insert=(org,inspection,evidence,version,actor)=>f.pool.query(`INSERT INTO ai_artifacts (id,organization_id,inspection_id,evidence_id,source_version,kind,requested_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`,[randomUUID(),org,inspection,evidence,version,evidence?'image':'report',actor]);
  for(const action of [()=>insert(b.organizationId,a.id,null,1,f.workerB.user.id),()=>insert(a.organizationId,a.id,file.evidence.id,1,f.workerA.user.id),
    ()=>insert(a.organizationId,a.id,null,999,f.workerA.user.id),()=>insert(a.organizationId,a.id,null,1,f.workerB.user.id)]) await assert.rejects(action(),{ code:'23503' });
  const artifact=await f.request(a);
  await assert.rejects(f.pool.query(`INSERT INTO background_jobs (id,organization_id,inspection_id,kind,dedupe_key,ai_artifact_id)
    VALUES ($1,$2,$3,'assist_inspection',$5,$4)`,[randomUUID(),a.organizationId,other.id,artifact.id,randomUUID()]),{ code:'23503' });
  for(const [org,id,actor,version] of [[b.organizationId,b.id,f.workerB.user.id,1],[a.organizationId,a.id,f.workerB.user.id,1],[a.organizationId,a.id,f.workerA.user.id,999]]) {
    await assert.rejects(f.pool.query(`INSERT INTO ai_reviews (id,organization_id,inspection_id,artifact_id,decision,confirmed_output,reviewed_by,applied_version)
      VALUES ($1,$2,$3,$4,'apply','{}'::jsonb,$5,$6)`,[randomUUID(),org,id,artifact.id,actor,version]),{ code:'23503' });
  }
});

test('M5 HTTP scope rejects other tenants, unassigned workers, admin edits and injected provenance',async()=>{
  const row=await f.fresh(),artifact=await f.ready(row);
  for(const actor of [f.orgB,f.workerA2,f.workerB]) {
    await f.send('get',`/inspections/${row.id}/ai`,actor).expect(404);
    await f.send('post',`/inspections/${row.id}/ai`,actor,intent({ kind:'report',baseVersion:1 })).expect(actor.user.role==='admin'?403:404);
    await review(row,artifact,reviewBody(row),actor).expect(actor.user.role==='admin'?403:404);
  }
  await f.send('get',`/inspections/${row.id}/ai`,f.orgA).expect(200);
  await review(row,artifact,reviewBody(row),f.orgA).expect(403);
  await f.send('post',`/inspections/${row.id}/ai`,f.workerA,intent({ kind:'report',baseVersion:1,organizationId:row.organizationId,model:'untrusted' })).expect(400);
  await review(row,artifact,reviewBody(row,{ provider:'untrusted' })).expect(400);
  await review(row,artifact,reviewBody(row,{ confirmed:false })).expect(400);
  assert.equal((await f.detail(row)).inspection.version,1);
});

test('M5 source requests deduplicate across mutation IDs and roll back artifacts/jobs/receipts together',async()=>{
  const row=await f.fresh(),body=intent({ kind:'report',baseVersion:1 });
  const a=await f.request(row,'report',null,f.workerA,body),b=await f.request(row);
  assert.equal(a.id,b.id); assert.equal((await f.request(row,'report',null,f.workerA,body)).id,a.id);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM background_jobs WHERE organization_id=$1 AND ai_artifact_id=$2',[row.organizationId,a.id])).rows[0].n,1);
  await f.send('post',`/inspections/${row.id}/ai`,f.workerA,{ ...body,baseVersion:2 }).expect(409).expect((res)=>assert.equal(res.body.error.code,'MUTATION_ID_REUSED'));
  const failing=await f.fresh(),failure=intent({ kind:'report',baseVersion:1 });
  await f.pool.query("CREATE FUNCTION reject_ai_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='assist_inspection' THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END; $$");
  await f.pool.query('CREATE TRIGGER reject_ai_job BEFORE INSERT ON background_jobs FOR EACH ROW EXECUTE FUNCTION reject_ai_job()');
  try {
    await f.send('post',`/inspections/${failing.id}/ai`,f.workerA,failure).expect(500);
    assert.equal((await f.pool.query('SELECT 1 FROM ai_artifacts WHERE organization_id=$1 AND inspection_id=$2',[failing.organizationId,failing.id])).rowCount,0);
    assert.equal((await f.pool.query('SELECT 1 FROM mutation_receipts WHERE organization_id=$1 AND user_id=$2 AND mutation_id=$3',[failing.organizationId,f.workerA.user.id,failure.mutationId])).rowCount,0);
  } finally { await f.pool.query('DROP TRIGGER reject_ai_job ON background_jobs; DROP FUNCTION reject_ai_job()'); }
  await f.request(failing,'report',null,f.workerA,failure);
});

test('M5 photo/audio assistance requires attached verified evidence of the matching type',async()=>{
  const row=await f.fresh(),file=await f.attach(row,{ ready:false }),current=file.inspection;
  await f.send('post',`/inspections/${row.id}/ai`,f.workerA,intent({ kind:'image',evidenceId:file.evidence.id,baseVersion:2 })).expect(409);
  const job=(await f.pool.query("SELECT * FROM background_jobs WHERE organization_id=$1 AND evidence_id=$2 AND kind='verify_evidence'",[row.organizationId,file.evidence.id])).rows[0];
  await f.run(job);
  await f.send('post',`/inspections/${row.id}/ai`,f.workerA,intent({ kind:'voice',evidenceId:file.evidence.id,baseVersion:2 })).expect(400);
  const artifact=await f.ready(current,'image',file.evidence.id);
  assert.equal(artifact.mode,'fallback'); assert.equal(artifact.original.findings.length,0); assert.match(artifact.original.warnings[0],/No image analysis/);
  const audio=await f.attach(current,{ bytes:wav,mimeType:'audio/wav',name:'voice.wav' });
  const voice=await f.ready(audio.inspection,'voice',audio.evidence.id);
  assert.equal(voice.original.transcript,''); assert.match(voice.original.warnings[0],/No transcription/);
});

test('M5 provider HTTP responses pass through real MinIO/BullMQ/PostgreSQL and remain suggestions until worker review',async()=>{
  // Only the paid provider boundary is a local HTTP simulation. Uploads,
  // queue delivery, immutable objects, transactions and review are real.
  const pipe=await createFixture('m5pipeline',{ AI_ENABLED:true,OPENAI_API_KEY:'synthetic-provider-test-key' });
  let server;
  try {
    const photo=await pipe.attach(await pipe.fresh());
    const audio=await pipe.attach(photo.inspection,{ bytes:wav,mimeType:'audio/wav',name:'voice.wav' });
    const row=audio.inspection,calls=[];
    server=createServer(async(req,res)=>{
      const chunks=[]; for await (const chunk of req) chunks.push(chunk);
      const body=Buffer.concat(chunks); calls.push({ path:req.url,body,headers:req.headers });
      res.setHeader('Content-Type','application/json');
      if (req.url==='/v1/audio/transcriptions') return res.end(JSON.stringify({ text:'The inspector reported a possible leak.' }));
      const context=JSON.parse(JSON.parse(body.toString('utf8')).input[0].content[0].text);
      res.end(JSON.stringify({ id:`pipeline-${context.kind}`,model:'pipeline-model-snapshot',status:'completed',
        output:[{ type:'message',content:[{ type:'output_text',text:JSON.stringify({
          text:'Suggested draft requiring confirmation.',transcript:'An extraction model must not replace the original transcript.',
          findings:[{ itemId:context.checklist[1].id,notes:'Possible leak; verify on site.' }],warnings:['Human review required.'],
        }) }] }] }));
    });
    await new Promise((resolve,reject)=>{ server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
    const origin=`http://127.0.0.1:${server.address().port}`;
    const provider=createAiProvider(pipe.settings,{ fetchImpl:(url,options)=>fetch(`${origin}${new URL(url).pathname}`,options) });
    const image=await pipe.request(row,'image',photo.evidence.id),voice=await pipe.request(row,'voice',audio.evidence.id);
    await pipe.runtime(async()=>{
      await poll(async()=> (await pipe.artifact(row,image.id)).status==='ready' && (await pipe.artifact(row,voice.id)).status==='ready','provider-backed AI jobs');
    },provider);
    assert.equal(calls.length,3);
    const imageRequest=calls.filter((call)=>call.path==='/v1/responses').map((call)=>JSON.parse(call.body.toString('utf8')))
      .find((body)=>JSON.parse(body.input[0].content[0].text).kind==='image');
    assert.equal(imageRequest.input[0].content[1].image_url,`data:image/png;base64,${png.toString('base64')}`);
    assert.equal(JSON.parse(imageRequest.input[0].content[0].text).sourceVersion,row.version);
    assert.ok(!JSON.stringify(imageRequest).includes(row.organizationId));
    const transcription=calls.find((call)=>call.path==='/v1/audio/transcriptions');
    assert.match(transcription.headers['content-type'],/multipart\/form-data/); assert.ok(transcription.body.includes(wav));
    const suggestion=await pipe.artifact(row,voice.id);
    assert.equal(suggestion.mode,'provider'); assert.equal(suggestion.sourceVersion,3);
    assert.equal(suggestion.original.transcript,'The inspector reported a possible leak.');
    assert.equal(suggestion.model,'pipeline-model-snapshot+gpt-transcribe');
    assert.equal((await pipe.detail(row)).inspection.version,3); assert.equal((await pipe.detail(row)).inspection.reportText,'');
    const reviewed=reviewBody(row,{ reportText:'Worker verified the leak after listening to the recording.' });
    const saved=(await pipe.send('post',`/inspections/${row.id}/ai/${voice.id}/review`,pipe.workerA,reviewed).expect(200)).body;
    assert.equal(saved.version,4); assert.equal(saved.aiSources[0].provider,'openai');
    const original=(await pipe.pool.query('SELECT raw_output FROM ai_artifacts WHERE organization_id=$1 AND inspection_id=$2 AND id=$3',[row.organizationId,row.id,voice.id])).rows[0];
    assert.equal(JSON.parse(original.raw_output).transcript,suggestion.original.transcript);
    assert.deepEqual((await pipe.artifact(row,voice.id)).original,suggestion.original);
    assert.equal((await pipe.artifact(row,voice.id)).review.confirmed.reportText,reviewed.reportText);
  } finally {
    if (server?.listening) await new Promise((resolve)=>{ server.close(resolve); server.closeAllConnections(); });
    await pipe.close();
  }
});

test('M5 generated artifacts do not modify checklist/report/version until explicit human review',async()=>{
  const row=await f.fresh(),artifact=await f.ready(row);
  const unchanged=await f.detail(row);
  assert.equal(unchanged.inspection.version,1); assert.equal(unchanged.inspection.reportText,''); assert.equal(unchanged.events.length,1);
  const body=reviewBody(row,{ reportText:'Inspected and confirmed by the worker',answers:row.template.items.map((item)=>({ itemId:item.id,outcome:'fail',notes:'Confirmed wear after checking equipment' })) });
  const saved=(await review(row,artifact,body).expect(200)).body;
  assert.equal(saved.version,2); assert.equal(saved.aiSources[0].sourceVersion,1); assert.equal(saved.aiSources[0].appliedVersion,2);
  assert.equal(saved.aiSources[0].reviewedBy,f.workerA.user.id);
  const result=await f.artifact(row,artifact.id);
  assert.deepEqual(result.original,artifact.original); assert.equal(result.review.confirmed.reportText,body.reportText);
  assert.equal(result.review.decision,'apply');
  const detail=await f.detail(row); assert.equal(detail.revisions.length,2); assert.equal(detail.events.at(-1).eventType,'ai_applied');
  await assert.rejects(f.pool.query("UPDATE ai_artifacts SET original_output='{}'::jsonb WHERE organization_id=$1 AND id=$2",[row.organizationId,artifact.id]),{ code:'P0001' });
  await assert.rejects(f.pool.query('UPDATE ai_artifacts SET source_version=2 WHERE organization_id=$1 AND id=$2',[row.organizationId,artifact.id]),{ code:'P0001' });
});

test('M5 lost-response and concurrent human reviews commit exactly one version and preserve immutable retry content',async()=>{
  const row=await f.fresh(),artifact=await f.ready(row),body=reviewBody(row);
  const responses=await Promise.all([review(row,artifact,body),review(row,artifact,body)]);
  assert.deepEqual(responses.map((res)=>res.status),[200,200]);
  assert.deepEqual(responses[0].body,responses[1].body);
  await review(row,artifact,body).expect(200);
  await review(row,artifact,{ ...body,reportText:'changed retry' }).expect(409).expect((res)=>assert.equal(res.body.error.code,'MUTATION_ID_REUSED'));
  assert.equal((await f.detail(row)).inspection.version,2);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM ai_reviews WHERE organization_id=$1 AND artifact_id=$2',[row.organizationId,artifact.id])).rows[0].n,1);
  const saved=(await f.detail(row)).inspection;
  await f.send('post',`/inspections/${row.id}/submit`,f.workerA,intent({ baseVersion:saved.version,...completeContent(saved) })).expect(200);
  await review(row,artifact,body).expect(200);
  assert.equal((await f.detail(row)).inspection.status,'submitted');
});

test('M5 failed review persistence rolls back the aggregate, revision, audit and receipt for an unchanged retry',async()=>{
  const row=await f.fresh(),artifact=await f.ready(row),body=reviewBody(row);
  await f.pool.query("CREATE FUNCTION reject_ai_review() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END; $$");
  await f.pool.query('CREATE TRIGGER reject_ai_review BEFORE INSERT ON ai_reviews FOR EACH ROW EXECUTE FUNCTION reject_ai_review()');
  try {
    await review(row,artifact,body).expect(500);
    const detail=await f.detail(row); assert.equal(detail.inspection.version,1); assert.equal(detail.revisions.length,1); assert.equal(detail.events.length,1);
    assert.equal((await f.pool.query('SELECT 1 FROM mutation_receipts WHERE organization_id=$1 AND mutation_id=$2',[row.organizationId,body.mutationId])).rowCount,0);
  } finally { await f.pool.query('DROP TRIGGER reject_ai_review ON ai_reviews; DROP FUNCTION reject_ai_review()'); }
  await review(row,artifact,body).expect(200);
});

test('M5 stale artifacts, invalid checklist IDs and closed inspections cannot overwrite human data',async()=>{
  const row=await f.fresh(),artifact=await f.ready(row);
  await review(row,artifact,reviewBody(row,{ answers:[{ itemId:randomUUID(),outcome:'pass',notes:'' }] })).expect(400);
  const current=(await f.send('patch',`/inspections/${row.id}`,f.workerA,intent({ baseVersion:1,...completeContent(row,'New human data') })).expect(200)).body;
  await review(current,artifact,reviewBody(current)).expect(409).expect((res)=>assert.equal(res.body.error.code,'STALE_AI_RESULT'));
  assert.equal((await f.detail(row)).inspection.reportText,'New human data');
  const submitted=(await f.send('post',`/inspections/${row.id}/submit`,f.workerA,intent({ baseVersion:2,...completeContent(current) })).expect(200)).body;
  await review(submitted,artifact,reviewBody(submitted)).expect(409).expect((res)=>assert.equal(res.body.error.code,'INVALID_STATE'));
  await f.send('post',`/inspections/${row.id}/ai`,f.workerA,intent({ kind:'report',baseVersion:3 })).expect(409);
});

test('M5 explicit rejection records only a human review and keeps report/version unchanged',async()=>{
  const row=await f.fresh(),artifact=await f.ready(row),body=intent({ decision:'reject',confirmed:true,baseVersion:1 });
  await review(row,artifact,body,f.orgA).expect(200);
  const current=await f.artifact(row,artifact.id);
  assert.equal(current.review.decision,'reject'); assert.equal(current.review.confirmed,null); assert.equal(current.review.appliedVersion,null);
  assert.equal((await f.detail(row)).inspection.version,1);
  await review(row,artifact,reviewBody(row)).expect(409).expect((res)=>assert.equal(res.body.error.code,'AI_ALREADY_REVIEWED'));
});

test('M5 removed evidence and revoked assignment stop background analysis before provider dispatch',async()=>{
  let calls=0; const provider={ async generate(){ calls++; throw new Error('Must not dispatch'); } };
  const file=await f.attach(await f.fresh()),artifact=await f.request(file.inspection,'image',file.evidence.id);
  await f.send('post',`/inspections/${file.inspection.id}/evidence/remove`,f.workerA,intent({ evidenceId:file.evidence.id,baseVersion:2 })).expect(200);
  await f.run(await f.job(artifact),provider); assert.equal((await f.artifact(file.inspection,artifact.id)).status,'failed');
  const row=await f.fresh(),pending=await f.request(row);
  await f.send('patch',`/inspections/${row.id}/assignment`,f.orgA,intent({ assignedTo:f.workerA2.user.id,baseVersion:1 })).expect(200);
  await f.run(await f.job(pending),provider);
  assert.equal((await f.artifact(row,pending.id,f.workerA2)).status,'failed'); assert.equal(calls,0);
});

test('M5 actual BullMQ delivers AI jobs, deduplicates redelivery and preserves queued work lost from Redis',async()=>{
  const row=await f.fresh(),artifact=await f.request(row);
  await f.runtime(async(runtime)=>{
    await poll(async()=> (await f.artifact(row,artifact.id)).status==='ready','BullMQ assistance');
    const before=await f.artifact(row,artifact.id);
    await runtime.queue.add('duplicate',{ organizationId:row.organizationId,jobId:(await f.job(artifact)).id },{ jobId:randomUUID(),removeOnComplete:true });
    await poll(async()=> (await runtime.queue.getActiveCount())===0,'duplicate delivery');
    assert.deepEqual((await f.artifact(row,artifact.id)).original,before.original);
    await runtime.worker.pause();
    const pendingRow=await f.fresh(),pending=await f.request(pendingRow),job=await f.job(pending);
    await runtime.reconcile(); const entry=await runtime.queue.getJob(job.id); if(entry) await entry.remove();
    // A timer-driven reconciliation may already be running; the explicit call
    // then returns without starting a second pass. Wait for durable republishing.
    await poll(async()=>{ await runtime.reconcile(); return await runtime.queue.getJob(job.id); },'re-published AI job');
    await runtime.worker.resume();
    await poll(async()=> (await f.artifact(pendingRow,pending.id)).status==='ready','reconciled AI job');
  });
});

test('M5 MinIO read failures retry without changing inspection evidence readiness or blocking manual submission',async()=>{
  const file=await f.attach(await f.fresh()),artifact=await f.request(file.inspection,'image',file.evidence.id),job=await f.job(artifact);
  await f.storage.remove(file.metadata.object_key);
  await assert.rejects(f.run(job)); assert.equal((await f.job(artifact)).status,'retry'); assert.equal((await f.artifact(file.inspection,artifact.id)).status,'queued');
  const submitted=(await f.send('post',`/inspections/${file.inspection.id}/submit`,f.workerA,intent({ baseVersion:2,...completeContent(file.inspection) })).expect(200)).body;
  assert.equal(submitted.status,'submitted');
  await f.storage.client.send(new PutObjectCommand({ Bucket:f.bucket,Key:file.metadata.object_key,Body:png,ContentType:'image/png' }));
  await f.pool.query('UPDATE background_jobs SET run_after=now() WHERE organization_id=$1 AND id=$2',[job.organization_id,job.id]);
  await f.run(job); assert.equal((await f.artifact(file.inspection,artifact.id)).status,'ready');
});

test('M5 job/artifact completion is one fenced transaction and retries a failed output write',async()=>{
  const row=await f.fresh(),artifact=await f.request(row),job=await f.job(artifact);
  await f.pool.query("CREATE FUNCTION reject_ai_output() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='ready' THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END; $$");
  await f.pool.query('CREATE TRIGGER reject_ai_output BEFORE UPDATE ON ai_artifacts FOR EACH ROW EXECUTE FUNCTION reject_ai_output()');
  try {
    await assert.rejects(f.run(job));
    assert.equal((await f.job(artifact)).status,'retry'); assert.equal((await f.artifact(row,artifact.id)).original,null);
  } finally { await f.pool.query('DROP TRIGGER reject_ai_output ON ai_artifacts; DROP FUNCTION reject_ai_output()'); }
  await f.pool.query('UPDATE background_jobs SET run_after=now() WHERE organization_id=$1 AND id=$2',[job.organization_id,job.id]);
  await f.run(job); assert.equal((await f.job(artifact)).status,'completed'); assert.equal((await f.artifact(row,artifact.id)).status,'ready');
});

test('M5 exhausted crash leases settle queued AI artifacts while stale workers cannot overwrite completed output',async()=>{
  const row=await f.fresh(),artifact=await f.request(row),job=await f.job(artifact);
  await f.pool.query("UPDATE background_jobs SET status='running',attempts=5,lease_token=$3,lease_until=now()-interval '1 second' WHERE organization_id=$1 AND id=$2",[row.organizationId,job.id,randomUUID()]);
  await recoverExpiredJobs(f.pool); assert.equal((await f.job(artifact)).status,'failed'); assert.equal((await f.artifact(row,artifact.id)).status,'failed');
  const next=await f.fresh(),pending=await f.request(next),work=await f.job(pending);
  let release; const gate=new Promise((resolve)=>{ release=resolve; });
  const slow={ async generate({ inspection,kind }) { await gate; const result=fallbackAssistance(kind,inspection,'disabled'); result.original.text='Stale worker'; return result; } };
  const first=f.run(work,slow);
  try {
    await poll(async()=> (await f.job(pending)).status==='running','old claim');
    await f.pool.query("UPDATE background_jobs SET lease_until=now()-interval '1 second' WHERE organization_id=$1 AND id=$2",[next.organizationId,work.id]);
    await f.run(work); const completed=await f.artifact(next,pending.id); release(); await first;
    assert.deepEqual((await f.artifact(next,pending.id)).original,completed.original);
  } finally { release(); await first.catch(()=>{}); }
});

test('M5 durable per-actor AI budget is tenant-scoped and shared across concurrent inspection requests',async()=>{
  const owner=await f.organization('AI budget'),worker=await f.worker(owner),a=await f.fresh(owner,worker),b=await f.fresh(owner,worker),original=f.settings.AI_MAX_PER_HOUR;
  f.settings.AI_MAX_PER_HOUR=1;
  try {
    const responses=await Promise.all([f.send('post',`/inspections/${a.id}/ai`,worker,intent({ kind:'report',baseVersion:1 })),f.send('post',`/inspections/${b.id}/ai`,worker,intent({ kind:'report',baseVersion:1 }))]);
    assert.deepEqual(responses.map((res)=>res.status).sort(),[201,429]);
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM ai_artifacts WHERE organization_id=$1 AND requested_by=$2',[owner.organization.id,worker.user.id])).rows[0].n,1);
  } finally { f.settings.AI_MAX_PER_HOUR=original; }
});

test('M5 workspace/worker analytics calculate real inspection, asset, failure, period and submission metrics without tenant leakage',async()=>{
  const owner=await f.organization('Analytics A'),foreign=await f.organization('Analytics B'),worker=await f.worker(owner),other=await f.worker(owner),outsider=await f.worker(foreign);
  const first=await f.fresh(owner,worker),second=await f.fresh(owner,other),hidden=await f.fresh(foreign,outsider);
  await f.send('post',`/inspections/${first.id}/submit`,worker,intent({ baseVersion:1,...completeContent(first),answers:first.template.items.map((item)=>({ itemId:item.id,outcome:'fail',notes:'Human-confirmed failure' })) })).expect(200);
  await f.send('post',`/inspections/${first.id}/review`,owner,intent({ baseVersion:2,decision:'approve',note:'Checked by admin' })).expect(200);
  await f.pool.query("UPDATE inspections SET created_at=now()-interval '1 day',submitted_at=now()-interval '22 hours' WHERE organization_id=$1 AND id=$2",[owner.organization.id,first.id]);
  await f.pool.query("UPDATE inspections SET created_at=now()-interval '40 days' WHERE organization_id=$1 AND id=$2",[owner.organization.id,second.id]);
  const data=(await f.send('get','/analytics?days=30',owner).expect(200)).body;
  assert.equal(data.scope,'workspace'); assert.equal(data.assets.total,1); assert.equal(data.inspections.total,1); assert.equal(data.inspections.byStatus.approved,1); assert.equal(data.inspections.failedChecks,2);
  assert.equal(data.inspections.averageSubmissionHours,2); assert.equal(data.activity.length,30); assert.equal(data.byAsset[0].approved,1);
  const assigned=(await f.send('get','/analytics?days=90',worker).expect(200)).body; assert.equal(assigned.scope,'assigned'); assert.equal(assigned.inspections.total,1);
  const admin=(await f.send('get','/analytics?days=90',owner).expect(200)).body; assert.equal(admin.inspections.total,2);
  const foreignAsset=f.directories.get(foreign.organization.id).asset.id;
  await f.send('get',`/analytics?assetId=${foreignAsset}`,owner).expect(404);
  await f.send('get','/analytics?organizationId=untrusted',owner).expect(400);
  await f.send('get','/analytics?days=365',owner).expect(400);
  await f.send('get',`/analytics?assetId=${f.directories.get(owner.organization.id).asset.id}`,outsider).expect(404);
  assert.ok(!data.byAsset.some((asset)=>asset.id===hidden.assetId));
});

test('M5 analytics remains bounded and measured with 1000 real PostgreSQL inspection rows',async()=>{
  const owner=await f.organization('Analytics performance'),worker=await f.worker(owner),row=await f.fresh(owner,worker);
  const seeded=await f.pool.query(`INSERT INTO inspections (id,organization_id,asset_id,template_id,assigned_to,asset_snapshot,template_snapshot,worker_snapshot,created_by,answers)
    SELECT gen_random_uuid(),organization_id,asset_id,template_id,assigned_to,asset_snapshot,template_snapshot,worker_snapshot,created_by,answers
    FROM inspections CROSS JOIN generate_series(1,999) WHERE organization_id=$1 AND id=$2 RETURNING *`,[owner.organization.id,row.id]);
  const revisions=seeded.rows.map((record)=>({ id:randomUUID(),organization_id:record.organization_id,inspection_id:record.id,created_by:record.created_by,snapshot:publicInspection(record) }));
  await f.pool.query(`INSERT INTO inspection_revisions (id,organization_id,inspection_id,version,created_by,snapshot)
    SELECT id,organization_id,inspection_id,1,created_by,snapshot FROM jsonb_to_recordset($1::jsonb)
      AS x(id uuid,organization_id uuid,inspection_id uuid,created_by uuid,snapshot jsonb)`,[JSON.stringify(revisions)]);
  const timings=[];
  for(let index=0;index<20;index++) { const start=performance.now(); const response=await f.send('get','/analytics?days=90',owner).expect(200); assert.equal(response.body.inspections.total,1000); assert.ok(response.body.byAsset.length<=50); timings.push(performance.now()-start); }
  timings.sort((a,b)=>a-b); const median=timings[10],p95=timings[18];
  assert.ok(p95<2000,`Local analytics p95 ${p95.toFixed(1)}ms exceeds the regression budget`);
  console.log(`M5 analytics: 1000 rows, 20 real HTTP/SQL reads, median ${median.toFixed(1)}ms, p95 ${p95.toFixed(1)}ms (local evidence, not fleet capacity).`);
});
