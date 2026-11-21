import { randomUUID } from 'node:crypto';
import { aiListSchema, saveInspectionSchema } from '@fieldsync/contracts';
import { HttpError } from '../../http/errors.js';
import { mutate } from '../../infrastructure/mutations.js';
import { transaction } from '../../infrastructure/transaction.js';
import { appendAudit, changesBetween } from '../../infrastructure/audit.js';
import { findInspection, updateInspection, appendRevision } from '../inspections/repository.js';
import { findEvidence } from '../evidence/repository.js';
import { enqueueJob } from '../jobs/repository.js';
import { findArtifact, publicArtifact, listArtifacts } from './repository.js';
import { isAiProviderEnabled } from './provider.js';

const editable = ['assigned', 'draft', 'changes_requested'];
function assertAccess(auth, inspection) {
  if (!inspection || (auth.user.role === 'worker' && inspection.assignedTo !== auth.user.id)) throw new HttpError(404, 'INSPECTION_NOT_FOUND', 'Inspection not found.');
}
function assertVersion(inspection, input) {
  if (inspection.version !== input.baseVersion) throw new HttpError(409, 'VERSION_CONFLICT', 'This inspection changed. Review its latest version.');
}
export function createAiService(pool, env) {
  async function authorize(db, auth, id) {
    const inspection = await findInspection(db, auth.organizationId, id, true); assertAccess(auth, inspection);
    return { inspection, inspectionReceiptId: id };
  }
  return {
    list(auth, id) {
      return transaction(pool, async (db) => {
        assertAccess(auth, await findInspection(db, auth.organizationId, id));
        return aiListSchema.parse({ artifacts: await listArtifacts(db, auth.organizationId, id), providerEnabled: isAiProviderEnabled(env) });
      }, { readOnly: true });
    },
    request(auth, id, input) {
      if (auth.user.role !== 'worker') throw new HttpError(403, 'FORBIDDEN', 'Only the assigned worker requests assistance for inspection content.');
      return mutate(pool, auth, `ai:${id}:request`, input, (db) => authorize(db, auth, id), async (db, { inspection }) => {
        assertVersion(inspection, input);
        if (!editable.includes(inspection.status)) throw new HttpError(409, 'INVALID_STATE', 'This inspection is read-only.');
        if (input.evidenceId) {
          const evidence = await findEvidence(db, auth.organizationId, id, input.evidenceId);
          if (!evidence || evidence.status !== 'attached' || !inspection.evidence.some((file) => file.id === evidence.id)) throw new HttpError(404, 'EVIDENCE_NOT_FOUND', 'Attached evidence not found.');
          if (evidence.processing_status !== 'ready') throw new HttpError(409, 'EVIDENCE_NOT_READY', 'Wait for evidence verification before requesting assistance.');
          if ((input.kind === 'image') !== evidence.mime_type.startsWith('image/')) throw new HttpError(400, 'INVALID_EVIDENCE_KIND', 'Choose matching photo or audio evidence.');
        }
        const existing = await db.query(`SELECT * FROM ai_artifacts WHERE organization_id=$1 AND inspection_id=$2 AND source_version=$3 AND kind=$4 AND evidence_id IS NOT DISTINCT FROM $5`,
          [auth.organizationId, id, inspection.version, input.kind, input.evidenceId]);
        if (existing.rowCount) return { body: publicArtifact(existing.rows[0]), inspectionId: id };
        // Bound provider cost across processes, not just one browser or API instance.
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`ai-budget:${auth.organizationId}:${auth.user.id}`]);
        const count = await db.query(`SELECT count(*)::int AS total FROM ai_artifacts WHERE organization_id=$1 AND requested_by=$2 AND created_at>now()-interval '1 hour'`, [auth.organizationId, auth.user.id]);
        if (count.rows[0].total >= (env.AI_MAX_PER_HOUR ?? 20)) throw new HttpError(429, 'AI_LIMIT_REACHED', 'Assistance limit reached. Continue manually and try again later.');
        const artifactId = randomUUID();
        const created = await db.query(`INSERT INTO ai_artifacts (id,organization_id,inspection_id,evidence_id,source_version,kind,requested_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [artifactId, auth.organizationId, id, input.evidenceId, inspection.version, input.kind, auth.user.id]);
        await enqueueJob(db, auth.organizationId, id, 'assist_inspection', `ai:${artifactId}`, { evidenceId: input.evidenceId, artifactId });
        return { body: publicArtifact(created.rows[0]), inspectionId: id };
      });
    },
    review(auth, id, artifactId, input) {
      if (input.decision === 'apply' && auth.user.role !== 'worker') throw new HttpError(403, 'FORBIDDEN', 'Only the assigned worker can apply reviewed inspection content.');
      return mutate(pool, auth, `ai:${id}:${artifactId}:review`, input, async (db) => {
        const resource = await authorize(db, auth, id);
        const artifact = await findArtifact(db, auth.organizationId, id, artifactId, true);
        if (!artifact) throw new HttpError(404, 'AI_NOT_FOUND', 'Assistance not found.');
        return { ...resource, artifact };
      }, async (db, { inspection, artifact }) => {
        assertVersion(inspection, input);
        if (['approved', 'cancelled'].includes(inspection.status) || (input.decision === 'apply' && !editable.includes(inspection.status))) throw new HttpError(409, 'INVALID_STATE', 'This inspection is read-only.');
        if (input.decision === 'apply' && artifact.source_version !== inspection.version) throw new HttpError(409, 'STALE_AI_RESULT', 'This assistance belongs to an older version. Request fresh assistance.');
        if (artifact.status !== 'ready') throw new HttpError(409, 'AI_NOT_READY', 'Assistance is not ready for review.');
        const prior = await db.query('SELECT 1 FROM ai_reviews WHERE organization_id=$1 AND inspection_id=$2 AND artifact_id=$3', [auth.organizationId, id, artifactId]);
        if (prior.rowCount) throw new HttpError(409, 'AI_ALREADY_REVIEWED', 'This assistance was already reviewed.');
        let saved = inspection, confirmed = null;
        if (input.decision === 'apply') {
          const content = saveInspectionSchema.parse({ answers: input.answers, reportText: input.reportText, baseVersion: input.baseVersion, mutationId: input.mutationId });
          const ids = inspection.template.items.map((item) => item.id);
          if (content.answers.length !== ids.length || content.answers.some((answer) => !ids.includes(answer.itemId))) throw new HttpError(400, 'INVALID_CHECKLIST', 'Review the complete checklist belonging to this inspection.');
          confirmed = { answers: ids.map((itemId) => content.answers.find((answer) => answer.itemId === itemId)), reportText: content.reportText };
          const source = { artifactId, kind: artifact.kind, sourceVersion: artifact.source_version, appliedVersion: inspection.version + 1,
            provider: artifact.provider, model: artifact.model, mode: artifact.mode, reviewedBy: auth.user.id, reviewedAt: new Date().toISOString() };
          const next = { ...inspection, ...confirmed, status: 'draft', aiSources: [...inspection.aiSources.slice(-99), source] };
          saved = await updateInspection(db, auth.organizationId, id, inspection.version, next);
          await appendRevision(db, auth, saved);
          await appendAudit(db, 'inspection', auth, saved, 'ai_applied', changesBetween(inspection, saved, ['answers', 'reportText', 'status', 'aiSources']));
        }
        await db.query(`INSERT INTO ai_reviews (id,organization_id,inspection_id,artifact_id,decision,confirmed_output,reviewed_by,applied_version)
          VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`, [randomUUID(), auth.organizationId, id, artifactId, input.decision,
          confirmed ? JSON.stringify(confirmed) : null, auth.user.id, input.decision === 'apply' ? saved.version : null]);
        return { body: saved, inspectionId: id };
      });
    },
  };
}
