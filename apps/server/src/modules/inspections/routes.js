import { Router } from 'express';
import {
  createInspectionSchema, saveInspectionSchema, reassignInspectionSchema, cancelInspectionSchema,
  reviewInspectionSchema, inspectionSchema, inspectionDetailSchema, inspectionsResponseSchema,
  inspectionListQuerySchema, resourceIdParamsSchema, emptyRequestSchema,
} from '@fieldsync/contracts';
import { parseRequest } from '../../http/errors.js';
import { requireRole } from '../auth/middleware.js';
import { createInspectionsService } from './service.js';

export function createInspectionsRouter({ pool, requireAuth }) {
  const router = Router();
  const service = createInspectionsService(pool);
  router.use(requireAuth);
  router.get('/', async (req, res) => {
    res.json(inspectionsResponseSchema.parse({ inspections: await service.list(req.auth, parseRequest(inspectionListQuerySchema, req.query)) }));
  });
  router.get('/:id', async (req, res) => {
    parseRequest(emptyRequestSchema, req.query);
    const { id } = parseRequest(resourceIdParamsSchema, req.params);
    res.json(inspectionDetailSchema.parse(await service.detail(req.auth, id)));
  });
  router.post('/', requireRole('admin'), async (req, res) => {
    parseRequest(emptyRequestSchema, req.query);
    res.status(201).json(inspectionSchema.parse(await service.create(req.auth, parseRequest(createInspectionSchema, req.body))));
  });
  for (const [method, path, role, schema, action] of [
    ['patch', '/:id', 'worker', saveInspectionSchema, 'save'],
    ['post', '/:id/submit', 'worker', saveInspectionSchema, 'submit'],
    ['patch', '/:id/assignment', 'admin', reassignInspectionSchema, 'reassign'],
    ['post', '/:id/cancel', 'admin', cancelInspectionSchema, 'cancel'],
    ['post', '/:id/review', 'admin', reviewInspectionSchema, 'review'],
  ]) {
    router[method](path, requireRole(role), async (req, res) => {
      parseRequest(emptyRequestSchema, req.query);
      const { id } = parseRequest(resourceIdParamsSchema, req.params);
      res.json(inspectionSchema.parse(await service[action](req.auth, id, parseRequest(schema, req.body))));
    });
  }
  return router;
}
