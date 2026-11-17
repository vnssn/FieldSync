import { evidenceSchema, evidenceSnapshotSchema } from '@fieldsync/contracts';

export function publicEvidence(row) {
  return evidenceSchema.parse({ id:row.id,organizationId:row.organization_id,inspectionId:row.inspection_id,createdBy:row.created_by,
    name:row.name,mimeType:row.mime_type,size:row.size,sha256:row.sha256,kind:row.mime_type.startsWith('image/')?'photo':'audio',
    status:row.status,processingStatus:row.processing_status,createdAt:row.created_at.toISOString(),expiresAt:row.expires_at.toISOString() });
}
export function evidenceSnapshot(row) {
  const value = publicEvidence(row);
  return evidenceSnapshotSchema.parse({ id:value.id,name:value.name,mimeType:value.mimeType,size:value.size,sha256:value.sha256,kind:value.kind });
}
export async function findEvidence(db, organizationId, inspectionId, id, lock = false) {
  const result = await db.query(`SELECT * FROM evidence WHERE organization_id=$1 AND inspection_id=$2 AND id=$3${lock?' FOR UPDATE':''}`,
    [organizationId,inspectionId,id]);
  return result.rows[0] ?? null;
}
export async function listEvidence(db, organizationId, inspectionId) {
  const result = await db.query(`SELECT * FROM evidence WHERE organization_id=$1 AND inspection_id=$2 AND status='attached' ORDER BY created_at,id`,
    [organizationId,inspectionId]);
  return result.rows.map(publicEvidence);
}
