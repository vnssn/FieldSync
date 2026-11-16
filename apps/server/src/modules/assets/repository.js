import { assetSchema, assetEventSchema } from '@fieldsync/contracts';

export function publicAsset(row) {
  return assetSchema.parse({
    id: row.id, organizationId: row.organization_id, code: row.code, name: row.name,
    category: row.category, location: row.location, status: row.status, version: row.version,
    createdBy: row.created_by, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  });
}

export async function listAssets(db, organizationId, { status, q }) {
  // Escape LIKE metacharacters so search treats user input literally.
  const search = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const result = await db.query(`SELECT * FROM assets WHERE organization_id = $1
    AND ($2 = 'all' OR status = $2)
    AND (code ILIKE $3 OR name ILIKE $3 OR category ILIKE $3 OR location ILIKE $3)
    ORDER BY code, id`, [organizationId, status, search]);
  return result.rows.map(publicAsset);
}

export async function findAsset(db, organizationId, id, { lock = false } = {}) {
  const result = await db.query(`SELECT * FROM assets WHERE organization_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`,
    [organizationId, id]);
  return result.rows[0] ? publicAsset(result.rows[0]) : null;
}

export async function insertAsset(db, { id, organizationId, userId, input }) {
  const result = await db.query(`INSERT INTO assets (id, organization_id, code, name, category, location, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
  [id, organizationId, input.code, input.name, input.category, input.location, userId]);
  return publicAsset(result.rows[0]);
}

export async function updateAsset(db, organizationId, id, asset) {
  const result = await db.query(`UPDATE assets SET code = $3, name = $4, category = $5, location = $6,
    status = $7, version = version + 1, updated_at = clock_timestamp()
    WHERE organization_id = $1 AND id = $2 AND version = $8 RETURNING *`,
  [organizationId, id, asset.code, asset.name, asset.category, asset.location, asset.status, asset.version]);
  return result.rows[0] ? publicAsset(result.rows[0]) : null;
}

export async function insertEvent(db, { id, organizationId, assetId, userId, eventType, changes }) {
  await db.query(`INSERT INTO asset_events (id, organization_id, asset_id, actor_user_id, event_type, changes, created_at)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, clock_timestamp())`,
  [id, organizationId, assetId, userId, eventType, JSON.stringify(changes)]);
}

export async function listEvents(db, organizationId, assetId) {
  const result = await db.query(`SELECT e.*, u.name AS actor_name FROM asset_events e
    JOIN users u ON u.organization_id = e.organization_id AND u.id = e.actor_user_id
    WHERE e.organization_id = $1 AND e.asset_id = $2 ORDER BY e.created_at, e.id`, [organizationId, assetId]);
  return result.rows.map((row) => assetEventSchema.parse({
    id: row.id, organizationId: row.organization_id, assetId: row.asset_id,
    actorUserId: row.actor_user_id, actorName: row.actor_name, eventType: row.event_type,
    changes: row.changes, createdAt: row.created_at.toISOString(),
  }));
}
