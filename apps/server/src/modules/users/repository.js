import { userPublicSchema } from '@fieldsync/contracts';

export function publicUser(row) {
  return userPublicSchema.parse({
    id: row.id, organizationId: row.organization_id, name: row.name,
    email: row.email, role: row.role, createdAt: row.created_at.toISOString(),
  });
}

export async function insertUser(db, { id, organizationId, name, email, passwordHash, role }) {
  const result = await db.query(`INSERT INTO users (id, organization_id, name, email, password_hash, role)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, organization_id, name, email, role, created_at`,
  [id, organizationId, name, email, passwordHash, role]);
  return publicUser(result.rows[0]);
}

export async function listUsers(db, organizationId) {
  const result = await db.query(`SELECT id, organization_id, name, email, role, created_at FROM users
    WHERE organization_id = $1 ORDER BY created_at, id`, [organizationId]);
  return result.rows.map(publicUser);
}

export async function findCredentials(db, organizationId, email) {
  const result = await db.query(`SELECT u.*, o.name AS organization_name FROM users u
    JOIN organizations o ON o.id = u.organization_id
    WHERE u.organization_id = $1 AND u.email = $2`, [organizationId, email]);
  return result.rows[0];
}
