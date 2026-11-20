import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createFixture, poll } from './helpers/m5.js';
import { createJobRuntime } from '../apps/server/src/modules/jobs/worker.js';
import { enqueueJob } from '../apps/server/src/modules/jobs/repository.js';
import { transaction, jobsCommittedEvent } from '../apps/server/src/infrastructure/transaction.js';

let f;
before(async () => { f=await createFixture('m5idle'); });
after(async () => { await f?.close(); });

test('an idle real worker stops SQL polling and a committed job wakes it immediately', async () => {
  const row=await f.fresh();
  const runtime=createJobRuntime({ pool:f.pool,storage:f.storage,env:f.settings,logger:f.logger,intervalMs:20,idleIntervalMs:10000 });
  const originalQuery=f.pool.query;
  try {
    await runtime.reconcile();
    let queries=0;
    f.pool.query=function (...args) { queries++; return originalQuery.apply(this,args); };
    await new Promise((done) => setTimeout(done,180));
    assert.equal(queries,0,'idle worker must not query the database on its fast interval');
    f.pool.query=originalQuery;
    await transaction(f.pool,async (db) => {
      await enqueueJob(db,row.organizationId,row.id,'prepare_report',`idle-report:${row.id}`,{ payload:{ sourceVersion:row.version } });
    });
    await poll(async () => (await f.pool.query("SELECT status FROM background_jobs WHERE inspection_id=$1 AND kind='prepare_report'",[row.id])).rows[0]?.status==='completed',
      'committed job wake without waiting for idle recovery',3000);
  } finally { f.pool.query=originalQuery; await runtime.close(); }
});

test('future durable work wakes at its run_after deadline with a long idle interval', async () => {
  const row=await f.fresh();
  const runtime=createJobRuntime({ pool:f.pool,storage:f.storage,env:f.settings,logger:f.logger,intervalMs:20,idleIntervalMs:10000 });
  try {
    await runtime.reconcile();
    const runAfter=new Date(Date.now()+400);
    await transaction(f.pool,db => enqueueJob(db,row.organizationId,row.id,'prepare_report',`future-report:${row.id}`,
      { payload:{ sourceVersion:row.version },runAfter }));
    const job=await poll(async () => {
      const result=(await f.pool.query("SELECT status,updated_at FROM background_jobs WHERE inspection_id=$1 AND kind='prepare_report'",[row.id])).rows[0];
      return result?.status==='completed' && result;
    },'future job deadline',3000);
    assert.ok(job.updated_at>=runAfter,'future work must not run early');
  } finally { await runtime.close(); }
});

test('real API evidence commits wake verification and future cleanup does not keep fast polling alive', async () => {
  const row=await f.fresh();
  const runtime=createJobRuntime({ pool:f.pool,storage:f.storage,env:f.settings,logger:f.logger,intervalMs:20,idleIntervalMs:10000 });
  const originalQuery=f.pool.query;
  try {
    await runtime.reconcile();
    const file=await f.attach(row,{ ready:false });
    await poll(async () => (await f.pool.query('SELECT processing_status FROM evidence WHERE id=$1',[file.evidence.id])).rows[0]?.processing_status==='ready',
      'API-triggered verification wake',3000);
    await runtime.reconcile();
    let queries=0;
    f.pool.query=function (...args) { queries++; return originalQuery.apply(this,args); };
    await new Promise((done) => setTimeout(done,180));
    assert.equal(queries,0,'a cleanup job due in twenty-one minutes must allow idle sleep');
  } finally { f.pool.query=originalQuery; await runtime.close(); }
});

test('rolled-back jobs emit no wake and their client does not leak a signal into the next transaction', async () => {
  const row=await f.fresh(); let signals=0;
  const listener=() => { signals++; };
  f.pool.on(jobsCommittedEvent,listener);
  try {
    await assert.rejects(transaction(f.pool,async (db) => {
      await enqueueJob(db,row.organizationId,row.id,'prepare_report',`rollback-report:${row.id}`,{ payload:{ sourceVersion:row.version } });
      throw new Error('rollback fixture');
    }),/rollback fixture/);
    await transaction(f.pool,db => db.query('SELECT 1'));
    assert.equal(signals,0);
    assert.equal((await f.pool.query('SELECT id FROM background_jobs WHERE inspection_id=$1',[row.id])).rowCount,0);
  } finally { f.pool.off(jobsCommittedEvent,listener); }
});
