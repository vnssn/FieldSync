import { Router } from 'express';
import { reserveEvidenceSchema,evidenceMutationSchema,evidenceSchema,inspectionSchema,resourceIdParamsSchema,
  evidenceParamsSchema,archiveParamsSchema,emptyRequestSchema,uploadResponseSchema } from '@fieldsync/contracts';
import { parseRequest } from '../../http/errors.js';
import { createEvidenceService } from './service.js';

export function createEvidenceRouter({ pool,storage,logger,requireAuth }) {
  const router = Router(), service = createEvidenceService(pool,storage,logger);
  router.use((req,res,next) => /^\/[^/]+\/(evidence|jobs|archives)(\/|$)/.test(req.path) ? requireAuth(req,res,next) : next('router'));
  router.use((req,_res,next) => { parseRequest(emptyRequestSchema,req.query); next(); });
  const id = (req) => parseRequest(resourceIdParamsSchema,req.params).id;
  router.post('/:id/evidence/reserve',async (req,res) => res.status(201).json(evidenceSchema.parse(await service.reserve(req.auth,id(req),parseRequest(reserveEvidenceSchema,req.body)))));
  router.post('/:id/evidence/:evidenceId/upload',async (req,res) => {
    const params = parseRequest(evidenceParamsSchema,req.params); parseRequest(emptyRequestSchema,req.body);
    res.json(uploadResponseSchema.parse(await service.upload(req.auth,params.id,params.evidenceId)));
  });
  router.post('/:id/evidence',async (req,res) => res.json(inspectionSchema.parse(await service.attach(req.auth,id(req),parseRequest(evidenceMutationSchema,req.body)))));
  router.post('/:id/evidence/remove',async (req,res) => res.json(inspectionSchema.parse(await service.remove(req.auth,id(req),parseRequest(evidenceMutationSchema,req.body)))));
  router.get('/:id/evidence',async (req,res) => res.json(await service.list(req.auth,id(req))));
  router.get('/:id/evidence/:evidenceId/download',async (req,res) => {
    const params = parseRequest(evidenceParamsSchema,req.params), file = await service.download(req.auth,params.id,params.evidenceId);
    res.set('Content-Type',file.mimeType).set('Content-Disposition','inline').set('Cross-Origin-Resource-Policy','same-origin').send(file.bytes);
  });
  router.get('/:id/jobs',async (req,res) => res.json(await service.jobs(req.auth,id(req))));
  router.get('/:id/archives/:jobId',async (req,res) => {
    const params = parseRequest(archiveParamsSchema,req.params);
    res.set('Content-Type','text/html; charset=utf-8').set('Content-Security-Policy',"sandbox; default-src 'none'; style-src 'unsafe-inline'")
      .send(await service.archive(req.auth,params.id,params.jobId));
  });
  return router;
}
