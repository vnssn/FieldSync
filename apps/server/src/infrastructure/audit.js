import { randomUUID } from 'node:crypto';
import { auditEventSchema } from '@fieldsync/contracts';

// Identifiers come only from this fixed map; request values remain SQL parameters.
const sources = {
  template: { table: 'template_events', key: 'template_id' },
  inspection: { table: 'inspection_events', key: 'inspection_id' },
};
export function changesBetween(before, after, fields) {
  return Object.fromEntries(fields.filter((field) => JSON.stringify(before?.[field]) !== JSON.stringify(after[field]))
    .map((field) => [field, { before: before?.[field] ?? null, after: after[field] }]));
}
export async function appendAudit(db, kind, auth, resource, eventType, changes, note = '') {
  const { table, key } = sources[kind];
  await db.query(`INSERT INTO ${table} (id, organization_id, ${key}, actor_user_id, event_type, version, details)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
  [randomUUID(), auth.organizationId, resource.id, auth.user.id, eventType, resource.version, JSON.stringify({ changes, note })]);
}
export async function listAudit(db, kind, organizationId, resourceId) {
  const { table, key } = sources[kind];
  const result = await db.query(`SELECT e.*, e.${key} AS resource_id, u.name AS actor_name FROM ${table} e
    JOIN users u ON u.organization_id = e.organization_id AND u.id = e.actor_user_id
    WHERE e.organization_id = $1 AND e.${key} = $2 ORDER BY e.version, e.created_at, e.id`, [organizationId, resourceId]);
  return result.rows.map((row) => auditEventSchema.parse({
    id: row.id, organizationId: row.organization_id, resourceId: row.resource_id,
    actorUserId: row.actor_user_id, actorName: row.actor_name, eventType: row.event_type,
    version: row.version, details: row.details, createdAt: row.created_at.toISOString(),
  }));
}
