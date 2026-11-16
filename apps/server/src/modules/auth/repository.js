export async function insertOrganization(db, id, name) {
  await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [id, name]);
}

export async function insertSession(db, { id, organizationId, userId, expiresAt }) {
  await db.query(`INSERT INTO sessions (id, organization_id, user_id, expires_at)
    VALUES ($1, $2, $3, $4)`, [id, organizationId, userId, expiresAt]);
}

export async function findSession(db, id) {
  // The opaque session credential is the bootstrap identity; all joins include its tenant.
  const result = await db.query(`SELECT u.id, u.organization_id, u.name, u.email, u.role, u.created_at,
      o.name AS organization_name FROM sessions s
    JOIN users u ON u.organization_id = s.organization_id AND u.id = s.user_id
    JOIN organizations o ON o.id = s.organization_id
    WHERE s.id = $1 AND s.expires_at > now()`, [id]);
  return result.rows[0];
}

export async function deleteSession(db, id, organizationId, userId) {
  await db.query('DELETE FROM sessions WHERE id = $1 AND organization_id = $2 AND user_id = $3',
    [id, organizationId, userId]);
}
