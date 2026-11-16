import { Router } from 'express';
import {
  createAssetSchema, updateAssetSchema, assetSchema, assetDetailSchema,
  assetsResponseSchema, assetListQuerySchema, assetIdParamsSchema, emptyRequestSchema,
} from '@fieldsync/contracts';
import { parseRequest } from '../../http/errors.js';
import { requireRole } from '../auth/middleware.js';
import { createAssetsService } from './service.js';

export function createAssetsRouter({ pool, requireAuth }) {
  const router = Router();
  const service = createAssetsService(pool);
  router.use(requireAuth);
  router.get('/', async (request, response) => {
    const assets = await service.list(request.auth, parseRequest(assetListQuerySchema, request.query));
    response.json(assetsResponseSchema.parse({ assets }));
  });
  router.get('/:id', async (request, response) => {
    parseRequest(emptyRequestSchema, request.query);
    const { id } = parseRequest(assetIdParamsSchema, request.params);
    response.json(assetDetailSchema.parse(await service.detail(request.auth, id)));
  });
  router.post('/', requireRole('admin'), async (request, response) => {
    parseRequest(emptyRequestSchema, request.query);
    const asset = await service.create(request.auth, parseRequest(createAssetSchema, request.body));
    response.status(201).json(assetSchema.parse(asset));
  });
  router.patch('/:id', requireRole('admin'), async (request, response) => {
    parseRequest(emptyRequestSchema, request.query);
    const { id } = parseRequest(assetIdParamsSchema, request.params);
    const asset = await service.update(request.auth, id, parseRequest(updateAssetSchema, request.body));
    response.json(assetSchema.parse(asset));
  });
  return router;
}
