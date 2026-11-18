import { Router } from 'express';
import { resourceIdParamsSchema, aiParamsSchema, emptyRequestSchema, requestAiSchema, reviewAiSchema, aiArtifactSchema, inspectionSchema } from '@fieldsync/contracts';
import { parseRequest } from '../../http/errors.js';
import { createAiService } from './service.js';

export function createAiRouter({ pool, env, requireAuth, limit }) {
  const router = Router(), service = createAiService(pool, env);
  router.use((req, res, next) => /^\/[^/]+\/ai(\/|$)/.test(req.path) ? requireAuth(req, res, next) : next('router'));
  router.use((req, _res, next) => { parseRequest(emptyRequestSchema, req.query); next(); });
  router.get('/:id/ai', async (req, res) => res.json(await service.list(req.auth, parseRequest(resourceIdParamsSchema, req.params).id)));
  router.post('/:id/ai', limit, async (req, res) => res.status(201).json(aiArtifactSchema.parse(await service.request(req.auth,
    parseRequest(resourceIdParamsSchema, req.params).id, parseRequest(requestAiSchema, req.body)))));
  router.post('/:id/ai/:artifactId/review', async (req, res) => {
    const params = parseRequest(aiParamsSchema, req.params);
    res.json(inspectionSchema.parse(await service.review(req.auth, params.id, params.artifactId, parseRequest(reviewAiSchema, req.body))));
  });
  return router;
}
