import { HttpError } from './errors.js';
import { evidenceContentParamsSchema } from '@fieldsync/contracts';

export function isEvidenceContentUpload(request) {
  const match = /^\/api\/v1\/inspections\/([^/]+)\/evidence\/([^/]+)\/content\/([^/]+)$/.exec(request.originalUrl?.split('?')[0] ?? request.path);
  return request.method === 'PUT' && !!match && evidenceContentParamsSchema.safeParse({ id: match[1], evidenceId: match[2], uploadId: match[3] }).success;
}

export function createOriginGuard(env) {
  const allowedOrigins = applicationOrigins(env);
  return function originGuard(request, _response, next) {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
      // Fail closed, including login/registration, to prevent login CSRF too.
      if (!allowedOrigins.has(request.get('origin'))) {
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

export function applicationOrigins(env) {
  return new Set([env.APP_ORIGIN,...(env.ADDITIONAL_APP_ORIGINS ?? [])]);
}

export function createCorsGuard(env) {
  const origins = applicationOrigins(env);
  const methods = ['GET','HEAD','POST','PUT','PATCH','DELETE'];
  const headers = ['accept','content-type','x-amz-meta-sha256'];
  return (request,response,next) => {
    const origin = request.get('origin');
    response.vary('Origin');
    if (!origin) {
      if (request.method === 'OPTIONS') throw new HttpError(403,'INVALID_ORIGIN','A preflight requires an allowed application origin.');
      return next();
    }
    if (!origins.has(origin)) throw new HttpError(403,'INVALID_ORIGIN','This request must come from an allowed application origin.');
    response.set('Access-Control-Allow-Origin',origin).set('Access-Control-Allow-Credentials','true')
      .set('Access-Control-Expose-Headers','X-Request-Id');
    if (request.method !== 'OPTIONS') return next();
    response.vary('Access-Control-Request-Method').vary('Access-Control-Request-Headers');
    const method = request.get('access-control-request-method');
    const requested = (request.get('access-control-request-headers') ?? '').split(',').map((header) => header.trim().toLowerCase()).filter(Boolean);
    if (!methods.includes(method) || requested.some((header) => !headers.includes(header))) {
      throw new HttpError(403,'INVALID_PREFLIGHT','The requested method or headers are not allowed.');
    }
    response.set('Access-Control-Allow-Methods',methods.join(', ')).set('Access-Control-Allow-Headers',headers.join(', '))
      .set('Access-Control-Max-Age','600').status(204).end();
  };
}
