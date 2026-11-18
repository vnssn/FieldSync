import { randomUUID } from 'node:crypto';
import { jobSchema } from '@fieldsync/contracts';

export async function enqueueJob(db, organizationId, inspectionId, kind, key, { evidenceId = null, artifactId = null, payload = {}, runAfter = new Date() } = {}) {
  await db.query(`INSERT INTO background_jobs (id,organization_id,inspection_id,evidence_id,kind,dedupe_key,payload,run_after,ai_artifact_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) ON CONFLICT (organization_id,dedupe_key) DO NOTHING`,
  [randomUUID(),organizationId,inspectionId,evidenceId,kind,key,JSON.stringify(payload),runAfter,artifactId]);
}
export async function listJobs(db, organizationId, inspectionId) {
  const result = await db.query(`SELECT * FROM background_jobs WHERE organization_id=$1 AND inspection_id=$2
    AND kind IN ('verify_evidence','prepare_report') ORDER BY created_at,id`, [organizationId,inspectionId]);
  return result.rows.map((row) => jobSchema.parse({ id:row.id,organizationId:row.organization_id,inspectionId:row.inspection_id,evidenceId:row.evidence_id,
    kind:row.kind,status:row.status,attempts:row.attempts,summary:row.result?.summary ?? null,sourceVersion:row.payload.sourceVersion ?? null,
    createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString() }));
}
