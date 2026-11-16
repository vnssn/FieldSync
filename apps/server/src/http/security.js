import { HttpError } from './errors.js';

export function createOriginGuard(env) {
  const allowedOrigin = new URL(env.APP_ORIGIN).origin;
  return function originGuard(request, _response, next) {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
      // Fail closed, including login/registration, to prevent login CSRF too.
      if (request.get('origin') !== allowedOrigin) {
        throw new HttpError(403, 'INVALID_ORIGIN', 'This request must come from the application origin.');
      }
      if (!request.is('application/json')) {
        throw new HttpError(415, 'JSON_REQUIRED', 'Send an application/json request.');
      }
    }
    next();
  };
}
