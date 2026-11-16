import { Router } from 'express';
import { createWorkerSchema, userPublicSchema, usersResponseSchema, emptyRequestSchema } from '@fieldsync/contracts';
import { parseRequest } from '../../http/errors.js';
import { requireRole } from '../auth/middleware.js';
import { createUsersService } from './service.js';

export function createUsersRouter({ pool, requireAuth }) {
  const router = Router();
  const service = createUsersService(pool);
  router.use(requireAuth, requireRole('admin'));
  router.get('/', async (request, response) => {
    parseRequest(emptyRequestSchema, request.query);
    response.json(usersResponseSchema.parse({ users: await service.list(request.auth) }));
  });
  router.post('/', async (request, response) => {
    parseRequest(emptyRequestSchema, request.query);
    const user = await service.create(request.auth, parseRequest(createWorkerSchema, request.body));
    response.status(201).json(userPublicSchema.parse(user));
  });
  return router;
}
