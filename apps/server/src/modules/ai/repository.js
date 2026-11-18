import { aiArtifactSchema, aiOutputSchema } from '@fieldsync/contracts';
import { generationSchema } from './provider.js';

export function publicArtifact(row) {
  return aiArtifactSchema.parse({ id: row.id, organizationId: row.organization_id, inspectionId: row.inspection_id,
    evidenceId: row.evidence_id, kind: row.kind, sourceVersion: row.source_version, requestedBy: row.requested_by,
    status: row.status, provider: row.provider, model: row.model, mode: row.mode, fallbackReason: row.fallback_reason,
    promptVersion: row.prompt_version, providerRequestId: row.provider_request_id, original: row.original_output,
    review: row.decision ? { decision: row.decision, reviewedBy: row.reviewed_by, reviewerName: row.reviewer_name,
      reviewedAt: row.reviewed_at.toISOString(), appliedVersion: row.applied_version, confirmed: row.confirmed_output } : null,
    createdAt: row.created_at.toISOString(), completedAt: row.completed_at?.toISOString() ?? null });
}
export async function findArtifact(db, organizationId, inspectionId, id, lock = false) {
  const result = await db.query(`SELECT * FROM ai_artifacts WHERE organization_id=$1 AND inspection_id=$2 AND id=$3${lock ? ' FOR UPDATE' : ''}`,
    [organizationId, inspectionId, id]);
  return result.rows[0] ?? null;
}
export async function listArtifacts(db, organizationId, inspectionId) {
  const result = await db.query(`SELECT a.*,r.decision,r.confirmed_output,r.reviewed_by,r.applied_version,r.reviewed_at,u.name AS reviewer_name
    FROM ai_artifacts a LEFT JOIN ai_reviews r ON r.organization_id=a.organization_id AND r.inspection_id=a.inspection_id AND r.artifact_id=a.id
    LEFT JOIN users u ON u.organization_id=r.organization_id AND u.id=r.reviewed_by
    WHERE a.organization_id=$1 AND a.inspection_id=$2 ORDER BY a.created_at DESC,a.id LIMIT 200`, [organizationId, inspectionId]);
  return result.rows.map(publicArtifact);
}
export async function completeArtifact(db, job, generated) {
  const result = generationSchema.parse(generated);
  await db.query(`UPDATE ai_artifacts SET status='ready',provider=$4,model=$5,mode=$6,fallback_reason=$7,
    provider_request_id=$8,original_output=$9::jsonb,raw_output=$10,completed_at=clock_timestamp()
    WHERE organization_id=$1 AND inspection_id=$2 AND id=$3 AND status='queued'`,
  [job.organization_id, job.inspection_id, job.ai_artifact_id, result.provider, result.model, result.mode, result.fallbackReason,
    result.providerRequestId, JSON.stringify(aiOutputSchema.parse(result.original)), result.raw]);
}
