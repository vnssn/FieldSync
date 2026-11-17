import { Router } from 'express';
import {
  createTemplateSchema, updateTemplateSchema, templateSchema, templatesResponseSchema,
  templateListQuerySchema, resourceIdParamsSchema, templateDetailSchema, emptyRequestSchema,
} from '@fieldsync/contracts';
import { parseRequest } from '../../http/errors.js';
import { requireRole } from '../auth/middleware.js';
import { createTemplatesService } from './service.js';

export function createTemplatesRouter({ pool, requireAuth }) {
  const router = Router();
  const service = createTemplatesService(pool);
  router.use(requireAuth, requireRole('admin'));
  router.get('/', async (req, res) => {
    res.json(templatesResponseSchema.parse({ templates: await service.list(req.auth, parseRequest(templateListQuerySchema, req.query)) }));
  });
  router.get('/:id', async (req, res) => {
    parseRequest(emptyRequestSchema, req.query);
    const { id } = parseRequest(resourceIdParamsSchema, req.params);
    res.json(templateDetailSchema.parse(await service.detail(req.auth, id)));
  });
  router.post('/', async (req, res) => {
    parseRequest(emptyRequestSchema, req.query);
    res.status(201).json(templateSchema.parse(await service.create(req.auth, parseRequest(createTemplateSchema, req.body))));
  });
  router.patch('/:id', async (req, res) => {
    parseRequest(emptyRequestSchema, req.query);
    const { id } = parseRequest(resourceIdParamsSchema, req.params);
    res.json(templateSchema.parse(await service.update(req.auth, id, parseRequest(updateTemplateSchema, req.body))));
  });
  return router;
}
