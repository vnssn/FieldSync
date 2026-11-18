import { evidenceListSchema, jobsResponseSchema } from '@fieldsync/contracts';
import { randomUUID } from 'node:crypto';
import { transaction } from '../../infrastructure/transaction.js';
import { HttpError } from '../../http/errors.js';
import { mutate } from '../../infrastructure/mutations.js';
import { appendAudit, changesBetween } from '../../infrastructure/audit.js';
import { evidencePrefix, assertEvidenceKey, readEvidenceBytes } from '../../infrastructure/storage.js';
import { findInspection, publicInspection, appendRevision } from '../inspections/repository.js';
import { findEvidence, publicEvidence, evidenceSnapshot, listEvidence } from './repository.js';
import { enqueueJob, listJobs } from '../jobs/repository.js';

const editable = ['assigned','draft','changes_requested'];
export function assertInspectionAccess(auth, inspection) {
  if (!inspection || (auth.user.role === 'worker' && inspection.assignedTo !== auth.user.id)) throw new HttpError(404,'INSPECTION_NOT_FOUND','Inspection not found.');
}
function assertWorker(auth) {
  if (auth.user.role !== 'worker') throw new HttpError(403,'FORBIDDEN','Only the assigned worker can change evidence.');
}
function assertEditable(inspection) {
  if (!editable.includes(inspection.status)) throw new HttpError(409,'INVALID_STATE','Evidence is read-only in this inspection state.');
}
export function createEvidenceService(pool, storage, logger) {
  async function access(db, auth, inspectionId, lock = false) {
    const inspection = await findInspection(db,auth.organizationId,inspectionId,lock);
    assertInspectionAccess(auth,inspection); return inspection;
  }
  async function authorizedEvidence(auth, inspectionId, id, forAttachment = false) {
    const inspection = await access(pool,auth,inspectionId);
    const row = await findEvidence(pool,auth.organizationId,inspectionId,id);
    if (!row) throw new HttpError(404,'EVIDENCE_NOT_FOUND','Evidence not found.');
    if (forAttachment && row.status === 'staging') assertEditable(inspection);
    return row;
  }
  async function cleanup(key) {
    try { await storage.remove(key); } catch { logger?.warn('Evidence cleanup deferred to reconciliation'); }
  }
  async function membership(auth, inspectionId, input, action, candidate = null) {
    return mutate(pool,auth,`inspections:${inspectionId}:${action}`,input,async (db) => {
      const inspection = await access(db,auth,inspectionId,true);
      const row = await findEvidence(db,auth.organizationId,inspectionId,input.evidenceId,true);
      if (!row) throw new HttpError(404,'EVIDENCE_NOT_FOUND','Evidence not found.');
      return { inspection,row,inspectionReceiptId:inspectionId };
    },async (db,{ inspection:previous,row }) => {
      if (previous.version !== input.baseVersion) throw new HttpError(409,'VERSION_CONFLICT','This inspection changed. Review your retained attachments.');
      assertEditable(previous);
      let evidence;
      if (action === 'evidence_attached') {
        if (row.created_by !== auth.user.id || row.status !== 'staging' || !candidate) throw new HttpError(409,'INVALID_STATE','This upload cannot be attached again.');
        if (previous.evidence.length >= 50) throw new HttpError(400,'EVIDENCE_LIMIT','An inspection supports at most 50 attachments.');
        await db.query(`UPDATE evidence SET status='attached',object_key=$4 WHERE organization_id=$1 AND inspection_id=$2 AND id=$3`,[auth.organizationId,inspectionId,row.id,candidate]);
        evidence = [...previous.evidence,evidenceSnapshot(row)];
        await enqueueJob(db,auth.organizationId,inspectionId,'verify_evidence',`verify:${row.id}`,{ evidenceId:row.id });
      } else {
        if (row.status !== 'attached') throw new HttpError(409,'INVALID_STATE','This evidence is already removed.');
        await db.query(`UPDATE evidence SET status='removed',removed_at=clock_timestamp() WHERE organization_id=$1 AND inspection_id=$2 AND id=$3`,[auth.organizationId,inspectionId,row.id]);
        evidence = previous.evidence.filter((item) => item.id !== row.id);
        await enqueueJob(db,auth.organizationId,inspectionId,'cleanup_evidence',`remove:${row.id}`,{ evidenceId:row.id });
      }
      const result = await db.query(`UPDATE inspections SET evidence=$4::jsonb,version=version+1,updated_at=clock_timestamp()
        WHERE organization_id=$1 AND id=$2 AND version=$3 RETURNING *`,[auth.organizationId,inspectionId,input.baseVersion,JSON.stringify(evidence)]);
      if (!result.rows[0]) throw new HttpError(409,'VERSION_CONFLICT','This inspection changed. Review before retrying.');
      const inspection = publicInspection(result.rows[0]);
      await appendRevision(db,auth,inspection);
      await appendAudit(db,'inspection',auth,inspection,action,changesBetween(previous,inspection,['evidence']));
      return { body:inspection,inspectionId };
    });
  }
  return {
    async reserve(auth, inspectionId, input) {
      assertWorker(auth);
      return mutate(pool,auth,`inspections:${inspectionId}:reserve_evidence`,input,async (db) => ({
        inspection:await access(db,auth,inspectionId,true),inspectionReceiptId:inspectionId,
      }),async (db,{ inspection }) => {
        assertEditable(inspection);
        const previous = await findEvidence(db,auth.organizationId,inspectionId,input.evidenceId,true);
        if (previous) {
          if (previous.created_by !== auth.user.id || previous.name !== input.name || previous.mime_type !== input.mimeType
            || previous.size !== input.size || previous.sha256 !== input.sha256 || previous.status === 'removed') {
            throw new HttpError(409,'EVIDENCE_ID_REUSED','Queue a changed file with a new evidence ID.');
          }
          return { body:publicEvidence(previous),inspectionId };
        }
        const count = await db.query(`SELECT count(*)::int AS count FROM evidence WHERE organization_id=$1 AND inspection_id=$2
          AND (status='attached' OR (status='staging' AND expires_at>now()))`,[auth.organizationId,inspectionId]);
        if (count.rows[0].count >= 50) throw new HttpError(400,'EVIDENCE_LIMIT','An inspection supports at most 50 attachments.');
        const expires = new Date(Date.now()+20*60000),stagingKey=`${evidencePrefix(auth.organizationId,inspectionId,input.evidenceId)}/staging/${randomUUID()}`;
        const result = await db.query(`INSERT INTO evidence (id,organization_id,inspection_id,created_by,name,mime_type,size,sha256,staging_key,expires_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[input.evidenceId,auth.organizationId,inspectionId,auth.user.id,
          input.name,input.mimeType,input.size,input.sha256,stagingKey,expires]);
        await enqueueJob(db,auth.organizationId,inspectionId,'cleanup_stage',`stage:${stagingKey}`,{ evidenceId:input.evidenceId,payload:{ key:stagingKey },runAfter:new Date(expires.getTime()+60000) });
        return { body:publicEvidence(result.rows[0]),inspectionId };
      });
    },
    async upload(auth, inspectionId, id, origin) {
      assertWorker(auth);
      const row = await transaction(pool,async (db) => {
        assertEditable(await access(db,auth,inspectionId,true));
        let current=await findEvidence(db,auth.organizationId,inspectionId,id,true);
        if (!current) throw new HttpError(404,'EVIDENCE_NOT_FOUND','Evidence not found.');
        if (current.created_by !== auth.user.id || current.status !== 'staging') throw new HttpError(409,'INVALID_STATE','This upload is no longer staging.');
        if(current.expires_at<=new Date()) {
          // Renew transport credentials on a new staging key. Old credential/job
          // generations can neither overwrite nor delete the new upload.
          const key=`${evidencePrefix(auth.organizationId,inspectionId,id)}/staging/${randomUUID()}`,expires=new Date(Date.now()+20*60000);
          const result=await db.query(`UPDATE evidence SET staging_key=$4,expires_at=$5 WHERE organization_id=$1 AND inspection_id=$2 AND id=$3 RETURNING *`,[auth.organizationId,inspectionId,id,key,expires]);
          current=result.rows[0];
          await enqueueJob(db,auth.organizationId,inspectionId,'cleanup_stage',`stage:${key}`,{ evidenceId:id,payload:{ key },runAfter:new Date(expires.getTime()+60000) });
        }
        return current;
      });
      return storage.presign(row,{ origin });
    },
    async uploadContent(auth, inspectionId, id, uploadId, request) {
      assertWorker(auth);
      if (!storage.upload) throw new HttpError(404,'NOT_FOUND','This upload transport is unavailable.');
      // Reject before consuming bytes or contacting Cloudinary. Recheck after
      // reception under locks, so a reassignment/renewal cannot authorize a write.
      async function check(db, lock = false) {
        assertEditable(await access(db,auth,inspectionId,lock));
        const row = await findEvidence(db,auth.organizationId,inspectionId,id,lock);
        if (!row) throw new HttpError(404,'EVIDENCE_NOT_FOUND','Evidence not found.');
        if (row.created_by !== auth.user.id || row.status !== 'staging') throw new HttpError(409,'INVALID_STATE','This upload is no longer staging.');
        assertEvidenceKey(row,row.staging_key,'staging');
        if (row.expires_at <= new Date() || row.staging_key.split('/').at(-1) !== uploadId) {
          throw new HttpError(410,'UPLOAD_EXPIRED','This staging upload expired. Request a new upload.');
        }
        if (request.get('content-type') !== row.mime_type || request.get('x-amz-meta-sha256') !== row.sha256
          || (request.get('content-length') !== undefined && request.get('content-length') !== String(row.size))
          || request.get('content-encoding')) {
          throw new HttpError(400,'INVALID_FILE','Uploaded size, MIME type or checksum does not match the reservation.');
        }
        return row;
      }
      const expected = await check(pool);
      const bytes = await readEvidenceBytes(request,expected);
      await transaction(pool,async (db) => {
        const current = await check(db,true);
        if (current.staging_key !== expected.staging_key) throw new HttpError(410,'UPLOAD_EXPIRED','Request a new upload.');
        await storage.upload(current,bytes);
      });
    },
    async attach(auth, inspectionId, input) {
      assertWorker(auth);
      const row = await authorizedEvidence(auth,inspectionId,input.evidenceId,true);
      let candidate;
      if (row.status === 'staging' && row.created_by === auth.user.id) {
        if (row.expires_at <= new Date()) throw new HttpError(410,'UPLOAD_EXPIRED','This staging upload expired. Queue the file again with a new ID.');
        candidate = await storage.promote(row);
      }
      try { return await membership(auth,inspectionId,input,'evidence_attached',candidate); }
      finally {
        if (candidate) {
          // Receipt/audit failure or duplicate promotion must not delete a winner's bytes.
          // If PostgreSQL is unavailable, leave the candidate for the age-based sweeper.
          try {
            const current = await findEvidence(pool,auth.organizationId,inspectionId,input.evidenceId);
            if (current?.object_key !== candidate) await cleanup(candidate);
          } catch { logger?.warn('Evidence promotion cleanup deferred'); }
        }
      }
    },
    async remove(auth, inspectionId, input) {
      assertWorker(auth);
      const result = await membership(auth,inspectionId,input,'evidence_removed');
      const row = await findEvidence(pool,auth.organizationId,inspectionId,input.evidenceId);
      if (row?.status === 'removed') {
        await cleanup(row.object_key);
        await cleanup(row.staging_key);
      }
      return result;
    },
    async list(auth, inspectionId) { await access(pool,auth,inspectionId); return evidenceListSchema.parse({ evidence:await listEvidence(pool,auth.organizationId,inspectionId) }); },
    async download(auth, inspectionId, id) {
      const row = await authorizedEvidence(auth,inspectionId,id);
      if (row.status !== 'attached' || row.processing_status === 'failed') throw new HttpError(404,'EVIDENCE_NOT_FOUND','Evidence is unavailable or removed.');
      return { bytes:await storage.read(row.object_key,row),mimeType:row.mime_type };
    },
    async jobs(auth, inspectionId) { await access(pool,auth,inspectionId); return jobsResponseSchema.parse({ jobs:await listJobs(pool,auth.organizationId,inspectionId) }); },
    async archive(auth, inspectionId, jobId) {
      await access(pool,auth,inspectionId);
      const result = await pool.query(`SELECT result FROM background_jobs WHERE organization_id=$1 AND inspection_id=$2 AND id=$3 AND kind='prepare_report' AND status='completed'`,[auth.organizationId,inspectionId,jobId]);
      if (!result.rows[0]) throw new HttpError(404,'ARCHIVE_NOT_READY','Report archive is not ready.');
      return result.rows[0].result.html;
    },
  };
}
