import { randomUUID } from 'node:crypto';
import { insertUser, listUsers } from './repository.js';
import { hashPassword } from '../auth/passwords.js';
import { assertAdmin } from '../auth/middleware.js';

export function createUsersService(pool) {
  return {
    list(auth) {
      assertAdmin(auth);
      return listUsers(pool, auth.organizationId);
    },
    async create(auth, input) {
      assertAdmin(auth);
      const passwordHash = await hashPassword(input.password);
      return insertUser(pool, {
        id: randomUUID(), organizationId: auth.organizationId, ...input, passwordHash, role: 'worker',
      });
    },
  };
}
