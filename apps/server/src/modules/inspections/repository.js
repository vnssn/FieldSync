import { randomUUID } from 'node:crypto';
import { inspectionSchema, inspectionRevisionSchema, templateSnapshotSchema } from '@fieldsync/contracts';
import { HttpError } from '../../http/errors.js';
import { publicTemplate } from '../templates/repository.js';

export function publicInspection(row) {
  return inspectionSchema.parse({
    id: row.id, organizationId: row.organization_id, assetId: row.asset_id, templateId: row.template_id,
    assignedTo: row.assigned_to, asset: row.asset_snapshot, template: row.template_snapshot, worker: row.worker_snapshot,
    answers: row.answers, reportText: row.report_text, evidence: row.evidence ?? [], status: row.status, version: row.version,
    reviewNote: row.review_note, submittedAt: row.submitted_at?.toISOString() ?? null,
    approvedAt: row.approved_at?.toISOString() ?? null, approvedBy: row.approved_by,
    createdBy: row.created_by, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  });
}
export async function findInspection(db, organizationId, id, lock = false) {
  const result = await db.query(`SELECT * FROM inspections WHERE organization_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`,
    [organizationId, id]);
  return result.rows[0] ? publicInspection(result.rows[0]) : null;
}
export async function listInspections(db, auth, status) {
  const result = await db.query(`SELECT * FROM inspections WHERE organization_id = $1
    AND ($2::uuid IS NULL OR assigned_to = $2) AND ($3 = 'all' OR status = $3)
    ORDER BY created_at DESC, id`, [auth.organizationId, auth.user.role === 'worker' ? auth.user.id : null, status]);
  return result.rows.map(publicInspection);
}
export async function findWorker(db, organizationId, id) {
  const result = await db.query(`SELECT id, name, email FROM users WHERE organization_id = $1 AND id = $2 AND role = 'worker' FOR SHARE`,
    [organizationId, id]);
  if (!result.rows[0]) throw new HttpError(404, 'WORKER_NOT_FOUND', 'Worker not found in this organization.');
  return result.rows[0];
}
export async function assignmentSnapshots(db, auth, input) {
  const templates = await db.query('SELECT * FROM inspection_templates WHERE organization_id = $1 AND id = $2 FOR SHARE',
    [auth.organizationId, input.templateId]);
  if (!templates.rows[0]) throw new HttpError(404, 'TEMPLATE_NOT_FOUND', 'Template not found.');
  const template = publicTemplate(templates.rows[0]);
  if (template.status !== 'active') throw new HttpError(400, 'TEMPLATE_ARCHIVED', 'Choose an active template.');
  const assets = await db.query('SELECT id, code, name, category, location, status FROM assets WHERE organization_id = $1 AND id = $2 FOR SHARE',
    [auth.organizationId, input.assetId]);
  const asset = assets.rows[0];
  if (!asset) throw new HttpError(404, 'ASSET_NOT_FOUND', 'Asset not found.');
  if (asset.status !== 'active') throw new HttpError(400, 'ASSET_ARCHIVED', 'Choose an active asset.');
  const { status: _status, ...assetSnapshot } = asset;
  return {
    asset: assetSnapshot,
    template: templateSnapshotSchema.parse({ id: template.id, name: template.name, description: template.description, items: template.items, version: template.version }),
    worker: await findWorker(db, auth.organizationId, input.assignedTo),
  };
}
export async function insertInspection(db, auth, input, snapshots) {
  const result = await db.query(`INSERT INTO inspections
    (id, organization_id, asset_id, template_id, assigned_to, asset_snapshot, template_snapshot, worker_snapshot, created_by)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9) RETURNING *`,
  [randomUUID(), auth.organizationId, input.assetId, input.templateId, input.assignedTo,
    JSON.stringify(snapshots.asset), JSON.stringify(snapshots.template), JSON.stringify(snapshots.worker), auth.user.id]);
  return publicInspection(result.rows[0]);
}
export async function updateInspection(db, organizationId, id, baseVersion, next) {
  const result = await db.query(`UPDATE inspections SET answers = $3::jsonb, report_text = $4,
    status = $5, assigned_to = $6, worker_snapshot = $7::jsonb, review_note = $8,
    submitted_at = $9, approved_at = $10, approved_by = $11, version = version + 1, updated_at = clock_timestamp()
    WHERE organization_id = $1 AND id = $2 AND version = $12 RETURNING *`,
  [organizationId, id, JSON.stringify(next.answers), next.reportText, next.status, next.assignedTo,
    JSON.stringify(next.worker), next.reviewNote, next.submittedAt, next.approvedAt, next.approvedBy, baseVersion]);
  return result.rows[0] ? publicInspection(result.rows[0]) : null;
}
export async function appendRevision(db, auth, inspection) {
  await db.query(`INSERT INTO inspection_revisions (id, organization_id, inspection_id, version, snapshot, created_by)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
  [randomUUID(), auth.organizationId, inspection.id, inspection.version, JSON.stringify(inspection), auth.user.id]);
}
export async function listRevisions(db, organizationId, id) {
  const result = await db.query(`SELECT * FROM inspection_revisions WHERE organization_id = $1 AND inspection_id = $2 ORDER BY version`,
    [organizationId, id]);
  return result.rows.map((row) => inspectionRevisionSchema.parse({
    id: row.id, organizationId: row.organization_id, inspectionId: row.inspection_id, version: row.version,
    snapshot: row.snapshot, createdBy: row.created_by, createdAt: row.created_at.toISOString(),
  }));
}
