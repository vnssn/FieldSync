import { Router } from 'express';
import { registerOrgSchema, loginSchema, authResponseSchema, emptyRequestSchema } from '@fieldsync/contracts';
import { parseRequest } from '../../http/errors.js';
import { createAuthService } from './service.js';
import { readSessionToken, setSessionCookie, clearSessionCookie } from './session.js';

export function createAuthRouter({ pool, env, requireAuth }) {
  const router = Router();
  const service = createAuthService(pool, env);
  router.post('/register-org', async (request, response) => {
    parseRequest(emptyRequestSchema, request.query);
    const result = await service.register(parseRequest(registerOrgSchema, request.body));
    setSessionCookie(response, env, result.session);
    response.status(201).json(result.body);
  });
  router.post('/login', async (request, response) => {
    parseRequest(emptyRequestSchema, request.query);
    const result = await service.login(parseRequest(loginSchema, request.body), readSessionToken(request));
    setSessionCookie(response, env, result.session);
    response.json(result.body);
  });
  router.post('/logout', requireAuth, async (request, response) => {
    parseRequest(emptyRequestSchema, request.query);
    parseRequest(emptyRequestSchema, request.body);
    await service.logout(request.auth, readSessionToken(request));
    clearSessionCookie(response, env);
    response.status(204).end();
  });
  router.get('/me', requireAuth, (request, response) => {
    parseRequest(emptyRequestSchema, request.query);
    response.json(authResponseSchema.parse({ user: request.auth.user, organization: request.auth.organization }));
  });
  return router;
}
