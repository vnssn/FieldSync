import { z } from 'zod';

const port = z.coerce.number().int().min(1).max(65535);
const httpUrl = z.url().refine((value) => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}, {
  message: 'Use an http:// or https:// URL.',
});
const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

export const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: port.default(3000),
  WEB_PORT: port.default(5173),
  APP_ORIGIN: httpUrl.default('http://localhost:5173'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(168),
  POSTGRES_HOST: z.string().min(1).default('127.0.0.1'),
  POSTGRES_PORT: port.default(5432),
  POSTGRES_DB: z.string().min(1).default('fieldsync'),
  POSTGRES_USER: z.string().min(1).default('fieldsync'),
  POSTGRES_PASSWORD: z.string().min(8),
  REDIS_HOST: z.string().min(1).default('127.0.0.1'),
  REDIS_PORT: port.default(6379),
  REDIS_PASSWORD: z.string().min(8),
  QUEUE_PREFIX: z.string().regex(/^[a-zA-Z0-9_-]+$/).default('fieldsync-dev'),
  MINIO_API_PORT: port.default(9000),
  MINIO_CONSOLE_PORT: port.default(9001),
  MINIO_ROOT_USER: z.string().min(3),
  MINIO_ROOT_PASSWORD: z.string().min(8),
  S3_ENDPOINT: httpUrl.default('http://127.0.0.1:9000'),
  S3_PUBLIC_ENDPOINT: httpUrl.default('http://localhost:9000'),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/).default('fieldsync-dev'),
  S3_ACCESS_KEY_ID: z.string().min(3),
  S3_SECRET_ACCESS_KEY: z.string().min(8),
  S3_FORCE_PATH_STYLE: booleanString.prefault('true'),
  AI_ENABLED: booleanString.prefault('false'),
}).superRefine((value, context) => {
  if (value.NODE_ENV === 'production' && !value.APP_ORIGIN.startsWith('https://')) {
    context.addIssue({ code: 'custom', path: ['APP_ORIGIN'], message: 'Production requires HTTPS.' });
  }
});
