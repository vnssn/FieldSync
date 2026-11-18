import { randomUUID } from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { resolve } from 'node:path';
import { z } from 'zod';
import { HealthResponseSchema, ErrorResponseSchema } from '@fieldsync/contracts';
import { HttpError } from './http/errors.js';
import { createOriginGuard,createCorsGuard } from './http/security.js';
import { createRequireAuth } from './modules/auth/middleware.js';
import { createAuthRouter } from './modules/auth/routes.js';
import { createUsersRouter } from './modules/users/routes.js';
import { createAssetsRouter } from './modules/assets/routes.js';
import { createTemplatesRouter } from './modules/templates/routes.js';
import { createInspectionsRouter } from './modules/inspections/routes.js';
import { createEvidenceRouter } from './modules/evidence/routes.js';
import { createEvidenceStorage } from './infrastructure/storage.js';
import { createAiRouter } from './modules/ai/routes.js';
import { createAnalyticsRouter } from './modules/analytics/routes.js';
import { createRateLimits } from './http/rate-limit.js';

const HealthQuerySchema = z.object({}).strict();

export function createApp({ getHealth, logger, pool, env, storage, webDirectory }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy',env?.TRUST_PROXY_HOPS ?? 0);
  app.use(helmet({ contentSecurityPolicy:{ directives:{
    connectSrc:["'self'",...(env && env.EVIDENCE_STORAGE_PROVIDER !== 'cloudinary' ? [new URL(env.S3_PUBLIC_ENDPOINT).origin]:[])],
    imgSrc:["'self'",'blob:','data:'],mediaSrc:["'self'",'blob:'],
    upgradeInsecureRequests:env?.NODE_ENV==='production' ? []:null,
  } } }));
  app.use(pinoHttp({
    logger,
    genReqId: (_request, response) => {
      const id = randomUUID();
      response.setHeader('X-Request-Id', id);
      return id;
    },
  }));
  app.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Permissions-Policy','microphone=(self), camera=(), geolocation=()');
    next();
  });

  if (env) app.use('/api/v1',createCorsGuard(env));
  if (pool && env) {
    app.use('/api/v1', createOriginGuard(env));
    const requireAuth = createRequireAuth(pool);
    const limits = createRateLimits(env);
    // Checklist payloads have a bounded but larger size than M1 forms.
    app.use('/api/v1/templates', express.json({ limit: '128kb' }), createTemplatesRouter({ pool, requireAuth }));
    app.use('/api/v1/inspections', express.json({ limit: '128kb' }), createAiRouter({ pool,env,requireAuth,limit:limits.ai }),
      createEvidenceRouter({ pool, requireAuth, logger, storage:storage ?? createEvidenceStorage(env) }), createInspectionsRouter({ pool, requireAuth }));
    app.use('/api/v1', express.json({ limit: '32kb' }));
    app.use('/api/v1/auth',(req,res,next) => req.method==='POST' && ['/login','/register-org'].includes(req.path) ? limits.auth(req,res,next):next());
    app.use('/api/v1/auth', createAuthRouter({ pool, env, requireAuth }));
    app.use('/api/v1/users', createUsersRouter({ pool, requireAuth }));
    app.use('/api/v1/assets', createAssetsRouter({ pool, requireAuth }));
    app.use('/api/v1/analytics', createAnalyticsRouter({ pool,requireAuth }));
  }

  app.get('/api/v1/health', async (request, response) => {
    const query = HealthQuerySchema.safeParse(request.query);
    if (!query.success) {
      return response.status(400).json(ErrorResponseSchema.parse({
        error: { code: 'INVALID_REQUEST', message: 'The health endpoint accepts no query parameters.' },
        requestId: request.id,
      }));
    }

    const result = HealthResponseSchema.parse(await getHealth());
    response.setHeader('Cache-Control', 'no-store');
    return response.status(result.status === 'ok' ? 200 : 503).json(result);
  });

  if (webDirectory) {
    app.use(express.static(webDirectory,{ index:false,setHeaders:(res,path) => {
      if (path.includes(`${resolve(webDirectory,'assets')}`)) res.setHeader('Cache-Control','public, max-age=31536000, immutable');
    } }));
    app.get(/^\/(?!api(?:\/|$))[^.]*$/,(req,res,next) => {
      if (!req.accepts('html')) return next();
      res.sendFile(resolve(webDirectory,'index.html'));
    });
  }

  app.use((request, response) => {
    response.status(404).json(ErrorResponseSchema.parse({
      error: { code: 'NOT_FOUND', message: 'This endpoint does not exist.' },
      requestId: request.id,
    }));
  });

  app.use((error, request, response, _next) => {
    let failure = error;
    if (error.type === 'entity.parse.failed') failure = new HttpError(400, 'INVALID_JSON', 'Send valid JSON.');
    if (error.type === 'entity.too.large') failure = new HttpError(413, 'REQUEST_TOO_LARGE', 'The request is too large.');
    if (error.code === '23505') {
      failure = error.constraint === 'users_organization_id_email_key'
        ? new HttpError(409, 'DUPLICATE_EMAIL', 'A member with this email already exists in this organization.')
        : error.constraint === 'assets_organization_id_code_key'
          ? new HttpError(409, 'DUPLICATE_ASSET_CODE', 'An asset with this code already exists in this organization.')
          : new HttpError(409, 'DUPLICATE_RECORD', 'This record already exists.');
    }
    const expected = failure instanceof HttpError;
    if (!expected) request.log.error({ errorType: error.name }, 'Request failed');
    response.status(expected ? failure.status : 500).json(ErrorResponseSchema.parse({
      error: {
        code: expected ? failure.code : 'INTERNAL_ERROR',
        message: expected ? failure.message : 'The server could not complete this request.',
      },
      requestId: request.id,
    }));
  });

  return app;
}
