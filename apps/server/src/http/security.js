import { HttpError } from './errors.js';
import { evidenceContentParamsSchema } from '@fieldsync/contracts';

export function isEvidenceContentUpload(request) {
  const match = /^\/api\/v1\/inspections\/([^/]+)\/evidence\/([^/]+)\/content\/([^/]+)$/.exec(request.originalUrl?.split('?')[0] ?? request.path);
  return request.method === 'PUT' && !!match && evidenceContentParamsSchema.safeParse({ id: match[1], evidenceId: match[2], uploadId: match[3] }).success;
}

export function createOriginGuard(env) {
  const allowedOrigin = new URL(env.APP_ORIGIN).origin;
  return function originGuard(request, _response, next) {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
      // Fail closed, including login/registration, to prevent login CSRF too.
      if (request.get('origin') !== allowedOrigin) {
        throw new HttpError(403, 'INVALID_ORIGIN', 'This request must come from the application origin.');
      }
      const binaryUpload = env.EVIDENCE_STORAGE_PROVIDER === 'cloudinary' && isEvidenceContentUpload(request);
      if (!binaryUpload && !request.is('application/json')) {
        throw new HttpError(415, 'JSON_REQUIRED', 'Send an application/json request.');
      }
    }
    next();
  };
}
