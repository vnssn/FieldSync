import { Router } from 'express';
import { analyticsQuerySchema } from '@fieldsync/contracts';
import { parseRequest } from '../../http/errors.js';
import { createAnalyticsService } from './service.js';

export function createAnalyticsRouter({ pool,requireAuth }) {
  const router = Router(), service = createAnalyticsService(pool);
  router.use(requireAuth);
  router.get('/',async (req,res) => res.json(await service.summary(req.auth,parseRequest(analyticsQuerySchema,req.query))));
  return router;
}
