import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { z } from 'zod';
import { jobPayloadSchema,reportJobDataSchema,reportJobResultSchema,verificationResultSchema,inspectionSchema } from '@fieldsync/contracts';
import { transaction } from '../../infrastructure/transaction.js';
import { assertEvidenceKey } from '../../infrastructure/storage.js';
import { findEvidence } from '../evidence/repository.js';

const maxAttempts = 5;
const escape = (text) => String(text).replace(/[&<>"']/g,(char) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[char]);
export function prepareReport(inspection) {
  const summary = `${inspection.asset.code}: ${inspection.template.name}. ${inspection.answers.filter((item) => item.outcome==='fail').length} failed checks; ${inspection.evidence.length} attachments.`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Inspection report</title><style>body{font:16px sans-serif;max-width:900px;margin:40px auto;padding:16px}p{white-space:pre-wrap}li{margin:16px 0}</style></head><body>
    <h1>${escape(inspection.asset.name)}</h1><p>${escape(summary)}</p><p>Inspector: ${escape(inspection.worker.name)} · Version ${inspection.version}</p>
    <ol>${inspection.template.items.map((item) => {
      const answer = inspection.answers.find((row) => row.itemId===item.id);
      return `<li><strong>${escape(item.label)}</strong> — ${escape(answer?.outcome ?? 'Unanswered')}<p>${escape(answer?.notes ?? '')}</p></li>`;
    }).join('')}</ol><h2>Inspector summary</h2><p>${escape(inspection.reportText)}</p><h2>Evidence</h2><ul>${inspection.evidence.map((file) => `<li>${escape(file.name)} (${escape(file.mimeType)}, ${file.size} bytes)</li>`).join('')}</ul></body></html>`;
  return reportJobResultSchema.parse({ sourceVersion:inspection.version,summary,html });
}

export async function processJob({ pool,storage }, pointer) {
  const { organizationId,jobId } = jobPayloadSchema.parse(pointer), token = randomUUID();
  const claimed = await pool.query(`UPDATE background_jobs SET status='running',attempts=attempts+1,lease_token=$3,
    lease_until=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp()
    WHERE organization_id=$1 AND id=$2 AND attempts<$4
    AND ((status IN ('queued','retry') AND run_after<=now()) OR (status='running' AND lease_until<now())) RETURNING *`,[organizationId,jobId,token,maxAttempts]);
  const job = claimed.rows[0];
  if (!job) return;
  const heartbeat = setInterval(() => {
    pool.query(`UPDATE background_jobs SET lease_until=clock_timestamp()+interval '60 seconds' WHERE organization_id=$1 AND id=$2 AND lease_token=$3 AND status='running'`,[organizationId,jobId,token]).catch(() => {});
  },15000);
  try {
    let result = {};
    if (job.kind === 'prepare_report') {
      const data = reportJobDataSchema.parse(job.payload);
      const revision = await pool.query(`SELECT snapshot FROM inspection_revisions WHERE organization_id=$1 AND inspection_id=$2 AND version=$3`,[organizationId,job.inspection_id,data.sourceVersion]);
      if (!revision.rows[0]) throw new Error('Report revision missing');
      const inspection = inspectionSchema.parse(revision.rows[0].snapshot);
      if (inspection.organizationId !== organizationId || inspection.id !== job.inspection_id || inspection.version !== data.sourceVersion) {
        throw new Error('Report snapshot ownership or version mismatch');
      }
      result = prepareReport(inspection);
    } else {
      if(job.kind!=='cleanup_stage') z.object({}).strict().parse(job.payload);
      const row = await findEvidence(pool,organizationId,job.inspection_id,job.evidence_id);
      if (!row) throw new Error('Evidence metadata missing');
      if (job.kind === 'verify_evidence' && row.status==='attached') {
        await storage.read(row.object_key,row);
        result = verificationResultSchema.parse({ sha256:row.sha256,size:row.size,mimeType:row.mime_type });
      } else if (job.kind === 'cleanup_stage') {
        const { key }=z.object({ key:z.string().min(1).max(500) }).strict().parse(job.payload);
        assertEvidenceKey(row, key, 'staging');
        await storage.remove(key);
      }
      else if (job.kind === 'cleanup_evidence' && row.status==='removed') {
        assertEvidenceKey(row, row.object_key, 'verified');
        assertEvidenceKey(row, row.staging_key, 'staging');
        await storage.remove(row.object_key); await storage.remove(row.staging_key);
      } else if (!['verify_evidence','cleanup_evidence'].includes(job.kind)) throw new Error('Unsupported job kind');
    }
    await transaction(pool,async (db) => {
      const completed = await db.query(`UPDATE background_jobs SET status='completed',result=$4::jsonb,last_error=NULL,lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp()
        WHERE organization_id=$1 AND id=$2 AND lease_token=$3 AND status='running' RETURNING id`,[organizationId,jobId,token,JSON.stringify(result)]);
      if (completed.rowCount && job.kind==='verify_evidence') await db.query(`UPDATE evidence SET processing_status='ready'
        WHERE organization_id=$1 AND inspection_id=$2 AND id=$3 AND status='attached'`,[organizationId,job.inspection_id,job.evidence_id]);
    });
  } catch (error) {
    await transaction(pool,async (db) => {
      const changed = await db.query(`UPDATE background_jobs SET status=$4,last_error='Background processing failed',run_after=$5,
        lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2 AND lease_token=$3 AND status='running' RETURNING id`,
      [organizationId,jobId,token,job.attempts>=maxAttempts?'failed':'retry',new Date(Date.now()+1000*2**(job.attempts-1))]);
      if (changed.rowCount && job.kind==='verify_evidence' && job.attempts>=maxAttempts) await db.query(`UPDATE evidence SET processing_status='failed'
        WHERE organization_id=$1 AND inspection_id=$2 AND id=$3 AND status='attached'`,[organizationId,job.inspection_id,job.evidence_id]);
    });
    throw error;
  } finally { clearInterval(heartbeat); }
}

export async function recoverExpiredJobs(pool) {
  // The final attempt can die before the handler's catch block. Settle both the
  // durable job and evidence prerequisite atomically so submission cannot hang.
  await pool.query(`WITH exhausted AS (
    UPDATE background_jobs SET status='failed',last_error='Worker lease expired after maximum attempts',
      lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp()
    WHERE status='running' AND lease_until<now() AND attempts >= $1
    RETURNING organization_id,inspection_id,evidence_id,kind
  ) UPDATE evidence AS e SET processing_status='failed' FROM exhausted AS j
    WHERE j.kind='verify_evidence' AND e.organization_id=j.organization_id
      AND e.inspection_id=j.inspection_id AND e.id=j.evidence_id AND e.status='attached'`, [maxAttempts]);
}

// Reap only old, unreferenced objects; recent promotions may still be committing.
export async function reconcileObjects(pool,storage,olderThan = new Date(Date.now()-3600000)) {
  for await (const object of storage.objects()) {
    const match = /^org\/([^/]+)\/inspections\/([^/]+)\/([^/]+)\/(staging|verified)\/([^/]+)$/.exec(object.Key ?? '');
    if (!match || !z.array(z.uuid()).safeParse([match[1], match[2], match[3], match[5]]).success
      || !object.LastModified || object.LastModified>=olderThan) continue;
    const organizationId = match[1];
    const owner = await pool.query(`SELECT 1 FROM evidence WHERE organization_id=$1 AND
      ((object_key=$2 AND status='attached') OR (staging_key=$2 AND expires_at>now())) LIMIT 1`,[organizationId,object.Key]);
    if (!owner.rowCount) await storage.remove(object.Key);
  }
}

export function createJobRuntime({ pool,storage,env,logger,queueName='fieldsync-jobs',intervalMs=5000 }) {
  const redis = { host:env.REDIS_HOST,port:env.REDIS_PORT,password:env.REDIS_PASSWORD,connectTimeout:3000 };
  const connection = new Redis({ ...redis,maxRetriesPerRequest:null });
  // Queue commands fail promptly during an outage; required work remains in SQL.
  // BullMQ's blocking worker connection must retain unlimited request retries.
  const queueConnection = new Redis({ ...redis,maxRetriesPerRequest:1 });
  connection.on('error',() => logger?.warn('Background Redis connection unavailable'));
  queueConnection.on('error',() => logger?.warn('Background queue connection unavailable'));
  const queue = new Queue(queueName,{ connection:queueConnection,prefix:env.QUEUE_PREFIX });
  queue.on('error',() => logger?.warn('Background queue unavailable'));
  const worker = new Worker(queueName,async (job) => processJob({ pool,storage },job.data),{ connection,prefix:env.QUEUE_PREFIX,concurrency:2,lockDuration:30000 });
  worker.on('error',() => logger?.warn('Background worker unavailable'));
  worker.on('failed',() => logger?.warn('Background job will retry or remain failed in PostgreSQL'));
  let stopped=false,running=false,lastSweep=0;
  async function reconcile() {
    if (stopped || running) return;
    running=true;
    try {
      await recoverExpiredJobs(pool);
      const due = await pool.query(`SELECT id,organization_id FROM background_jobs WHERE attempts<5 AND
        ((status IN ('queued','retry') AND run_after<=now()) OR (status='running' AND lease_until<now())) ORDER BY run_after LIMIT 100`);
      for (const row of due.rows) {
        const existing = await queue.getJob(row.id);
        if (existing && ['completed','failed'].includes(await existing.getState())) await existing.remove();
        await queue.add('process',jobPayloadSchema.parse({ organizationId:row.organization_id,jobId:row.id }),{
          jobId:row.id,attempts:maxAttempts,backoff:{ type:'exponential',delay:1000 },removeOnComplete:100,removeOnFail:100,
        });
      }
      if (Date.now()-lastSweep>60000) { await reconcileObjects(pool,storage); lastSweep=Date.now(); }
    } catch { logger?.warn('Background reconciliation deferred'); }
    finally { running=false; }
  }
  const timer = setInterval(reconcile,intervalMs);
  reconcile();
  return { queue,worker,reconcile,
    async close() {
      stopped=true; clearInterval(timer);
      try {
        await worker.close();
        while(running) await new Promise((resolve) => setTimeout(resolve,20));
        await queue.close();
      } finally { connection.disconnect(); queueConnection.disconnect(); }
    },
  };
}
