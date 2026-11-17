import { createHash } from 'node:crypto';
import { transaction } from './transaction.js';
import { HttpError } from '../http/errors.js';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

// Serialize the receipt key, not every mutation in an organization. Resource locks
// and current authorization precede receipt replay; workflow/version checks follow it.
export async function mutate(pool, auth, operation, input, authorize, work) {
  const requestHash = createHash('sha256').update(JSON.stringify(canonical({ operation, input }))).digest('hex');
  const outcome = await transaction(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`${auth.organizationId}:${auth.user.id}:${input.mutationId}`]);
    const result = await db.query(`SELECT * FROM mutation_receipts
      WHERE organization_id = $1 AND user_id = $2 AND mutation_id = $3`,
    [auth.organizationId, auth.user.id, input.mutationId]);
    const receipt = result.rows[0];
    const resource = await authorize(db, receipt);
    if (receipt) {
      if (receipt.request_hash !== requestHash) throw new HttpError(409, 'MUTATION_ID_REUSED', 'Use a new mutation ID for changed content.');
      return receipt.outcome;
    }
    await db.query('SAVEPOINT mutation_work');
    let saved;
    let next;
    try {
      saved = await work(db, resource);
      next = { body: saved.body };
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      await db.query('ROLLBACK TO SAVEPOINT mutation_work');
      next = { error: { status: error.status, code: error.code, message: error.message } };
    }
    await db.query(`INSERT INTO mutation_receipts
      (organization_id, user_id, mutation_id, request_hash, outcome, template_id, inspection_id)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
    [auth.organizationId, auth.user.id, input.mutationId, requestHash, JSON.stringify(next),
      saved?.templateId ?? resource?.templateReceiptId ?? null, saved?.inspectionId ?? resource?.inspectionReceiptId ?? null]);
    return next;
  });
  if (outcome.error) throw new HttpError(outcome.error.status, outcome.error.code, outcome.error.message);
  return outcome.body;
}
