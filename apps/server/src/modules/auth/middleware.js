import { HttpError } from '../../http/errors.js';
import { findSession } from './repository.js';
import { readSessionToken, sessionId } from './session.js';
import { publicUser } from '../users/repository.js';
import { organizationSchema } from '@fieldsync/contracts';

export function createRequireAuth(pool) {
  return async function requireAuth(request, _response, next) {
    const token = readSessionToken(request);
    const row = token ? await findSession(pool, sessionId(token)) : null;
    if (!row) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    request.auth = {
      user: publicUser(row), organizationId: row.organization_id,
      organization: organizationSchema.parse({ id: row.organization_id, name: row.organization_name }),
    };
    next();
  };
}

export function requireRole(role) {
  return function roleGuard(request, _response, next) {
    if (!request.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    if (request.auth.user.role !== role) throw new HttpError(403, 'FORBIDDEN', role === 'admin' ? 'Administrator access is required.' : 'Worker access is required.');
    next();
  };
}

export function assertAdmin(auth) {
  if (auth.user.role !== 'admin') throw new HttpError(403, 'FORBIDDEN', 'Administrator access is required.');
}
