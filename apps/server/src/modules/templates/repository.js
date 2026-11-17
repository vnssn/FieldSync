import { templateSchema } from '@fieldsync/contracts';

export function publicTemplate(row) {
  return templateSchema.parse({
    id: row.id, organizationId: row.organization_id, name: row.name, description: row.description,
    items: row.items, status: row.status, version: row.version, createdBy: row.created_by,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  });
}
export async function findTemplate(db, organizationId, id, lock = false) {
  const result = await db.query(`SELECT * FROM inspection_templates WHERE organization_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`,
    [organizationId, id]);
  return result.rows[0] ? publicTemplate(result.rows[0]) : null;
}
export async function listTemplates(db, organizationId, status) {
  const result = await db.query(`SELECT * FROM inspection_templates WHERE organization_id = $1
    AND ($2 = 'all' OR status = $2) ORDER BY name, id`, [organizationId, status]);
  return result.rows.map(publicTemplate);
}
export async function insertTemplate(db, auth, id, input) {
  const result = await db.query(`INSERT INTO inspection_templates (id, organization_id, name, description, items, created_by)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING *`,
  [id, auth.organizationId, input.name, input.description, JSON.stringify(input.items), auth.user.id]);
  return publicTemplate(result.rows[0]);
}
export async function updateTemplate(db, organizationId, id, input) {
  const result = await db.query(`UPDATE inspection_templates SET name = $3, description = $4, items = $5::jsonb,
    status = $6, version = version + 1, updated_at = clock_timestamp()
    WHERE organization_id = $1 AND id = $2 AND version = $7 RETURNING *`,
  [organizationId, id, input.name, input.description, JSON.stringify(input.items), input.status, input.baseVersion]);
  return result.rows[0] ? publicTemplate(result.rows[0]) : null;
}
