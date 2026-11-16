import { randomUUID } from 'node:crypto';
import { authResponseSchema } from '@fieldsync/contracts';
import { transaction } from '../../infrastructure/transaction.js';
import { HttpError } from '../../http/errors.js';
import { insertUser, findCredentials, publicUser } from '../users/repository.js';
import { insertOrganization, insertSession, deleteSession } from './repository.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { newSession, sessionId } from './session.js';

export function createAuthService(pool, env) {
  return {
    async register(input) {
      const passwordHash = await hashPassword(input.password);
      return transaction(pool, async (db) => {
        const organization = { id: randomUUID(), name: input.organizationName };
        await insertOrganization(db, organization.id, organization.name);
        const user = await insertUser(db, {
          id: randomUUID(), organizationId: organization.id, name: input.name,
          email: input.email, passwordHash, role: 'admin',
        });
        const session = newSession(env, user);
        await insertSession(db, session);
        return { session, body: authResponseSchema.parse({ user, organization }) };
      });
    },
    async login(input, previousToken) {
      const row = await findCredentials(pool, input.organizationId, input.email);
      if (!await verifyPassword(row?.password_hash, input.password)) {
        throw new HttpError(401, 'INVALID_CREDENTIALS', 'Organization ID, email, or password is incorrect.');
      }
      const user = publicUser(row);
      const body = authResponseSchema.parse({
        user, organization: { id: row.organization_id, name: row.organization_name },
      });
      const session = newSession(env, user);
      await transaction(pool, async (db) => {
        if (previousToken) await deleteSession(db, sessionId(previousToken), user.organizationId, user.id);
        await insertSession(db, session);
      });
      return { session, body };
    },
    async logout(auth, token) {
      await deleteSession(pool, sessionId(token), auth.organizationId, auth.user.id);
    },
  };
}
