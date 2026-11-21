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
const optionalString = (schema) => z.preprocess((value) => value === '' ? undefined:value,schema.optional());
const connectionUrl = (protocols) => z.url().refine((value) => { try { return protocols.includes(new URL(value).protocol); } catch { return false; } },'Use a supported connection URL.');

const originUrl = httpUrl.refine((value) => {
  try { const url = new URL(value); return url.origin === value && !url.hostname.includes('*'); } catch { return false; }
}, 'Use an exact browser origin without credentials, path, query or fragment.');

export const EnvironmentSchema = z.preprocess((input) => {
  if (!input || typeof input !== 'object') return input;
  // Inactive provider settings cannot block startup (including stale R2 URLs).
  const ignored = input.EVIDENCE_STORAGE_PROVIDER === 'cloudinary' ? 'S3_' : 'CLOUDINARY_';
  return Object.fromEntries(Object.entries(input).filter(([key]) => !key.startsWith(ignored)));
}, z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: port.default(3000),
  WEB_PORT: port.default(5173),
  APP_ORIGIN: originUrl.default('http://localhost:5173'),
  ADDITIONAL_APP_ORIGINS: z.string().default('').transform((value) => value ? value.split(',').map((origin) => origin.trim()) : [])
    .pipe(z.array(originUrl).max(5)),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(168),
  SERVE_WEB: booleanString.prefault('false'),
  RUN_INLINE_WORKER: booleanString.prefault('false'),
  JOBS_IDLE_INTERVAL_MS: z.coerce.number().int().min(360000).max(86400000).default(1800000),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(1).default(0),
  AUTH_RATE_LIMIT: z.coerce.number().int().min(1).max(10000).default(60),
  AI_RATE_LIMIT: z.coerce.number().int().min(1).max(10000).default(10),
  DATABASE_URL: optionalString(connectionUrl(['postgres:','postgresql:'])),
  DATABASE_URL_UNPOOLED: optionalString(connectionUrl(['postgres:','postgresql:'])),
  MIGRATIONS_DATABASE_URL: optionalString(connectionUrl(['postgres:','postgresql:'])),
  POSTGRES_SSL: booleanString.prefault('false'),
  POSTGRES_HOST: z.string().min(1).default('127.0.0.1'),
  POSTGRES_PORT: port.default(5432),
  POSTGRES_DB: z.string().min(1).default('fieldsync'),
  POSTGRES_USER: z.string().min(1).default('fieldsync'),
  POSTGRES_PASSWORD: optionalString(z.string().min(8)),
  REDIS_URL: optionalString(connectionUrl(['redis:','rediss:'])),
  REDIS_HOST: z.string().min(1).default('127.0.0.1'),
  REDIS_PORT: port.default(6379),
  REDIS_PASSWORD: optionalString(z.string().min(8)),
  QUEUE_PREFIX: z.string().regex(/^[a-zA-Z0-9_-]+$/).default('fieldsync-dev'),
  MINIO_API_PORT: port.default(9000),
  MINIO_CONSOLE_PORT: port.default(9001),
  MINIO_ROOT_USER: optionalString(z.string().min(3)),
  MINIO_ROOT_PASSWORD: optionalString(z.string().min(8)),
  S3_ENDPOINT: httpUrl.default('http://127.0.0.1:9000'),
  S3_PUBLIC_ENDPOINT: httpUrl.default('http://localhost:9000'),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/).default('fieldsync-dev'),
  EVIDENCE_STORAGE_PROVIDER: z.enum(['s3', 'cloudinary']).default('s3'),
  S3_ACCESS_KEY_ID: optionalString(z.string().min(3)),
  S3_SECRET_ACCESS_KEY: optionalString(z.string().min(8)),
  S3_FORCE_PATH_STYLE: booleanString.prefault('true'),
  CLOUDINARY_CLOUD_NAME: optionalString(z.string().regex(/^[a-z0-9_-]+$/)),
  CLOUDINARY_API_KEY: optionalString(z.string().min(3)),
  CLOUDINARY_API_SECRET: optionalString(z.string().min(8)),
  CLOUDINARY_FOLDER: optionalString(z.string().regex(/^fieldsync-[a-z0-9][a-z0-9_-]{0,50}$/)),
  AI_ENABLED: booleanString.prefault('false'),
  AI_REPORT_PROVIDER: z.enum(['openai', 'groq']).default('openai'),
  GROQ_API_KEY: optionalString(z.string().trim().min(1).max(500)),
  GROQ_MODEL: z.string().trim().min(1).max(150).default('openai/gpt-oss-20b'),
  OPENAI_API_KEY: optionalString(z.string().trim().min(1).max(500)),
  OPENAI_MODEL: z.string().trim().min(1).max(60).default('gpt-5-mini'),
  OPENAI_TRANSCRIPTION_MODEL: z.string().trim().min(1).max(60).default('gpt-transcribe'),
  AI_TIMEOUT_MS: z.coerce.number().int().min(100).max(45000).default(30000),
  AI_MAX_PER_HOUR: z.coerce.number().int().min(1).max(1000).default(20),
}).superRefine((value, context) => {
  const requiredStorage = value.EVIDENCE_STORAGE_PROVIDER === 'cloudinary'
    ? ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'CLOUDINARY_FOLDER']
    : ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'];
  for (const key of requiredStorage) {
    if (!value[key]) context.addIssue({ code: 'custom', path: [key], message: 'Required for the selected evidence storage provider.' });
  }
  for (const [url,secret] of [['DATABASE_URL','POSTGRES_PASSWORD'],['REDIS_URL','REDIS_PASSWORD']]) {
    if (!value[url] && !value[secret]) context.addIssue({ code:'custom',path:[secret],message:'Provide a connection URL or local credentials.' });
  }
  if (value.REDIS_URL) {
    try {
      const path=new URL(value.REDIS_URL).pathname;
      if ((path && !/^\/(\d+)?$/.test(path)) || Number(path.slice(1))>16383) context.addIssue({ code:'custom',path:['REDIS_URL'],message:'Use an integer Redis database from 0 to 16383.' });
    } catch { /* The URL schema supplies the error. */ }
  }
  const databaseHost = (input) => {
    try { return new URL(input).hostname; } catch { return ''; }
  };
  const migrationsUrl = value.MIGRATIONS_DATABASE_URL ?? value.DATABASE_URL_UNPOOLED;
  if (value.DATABASE_URL && databaseHost(value.DATABASE_URL).includes('-pooler.')
    && !migrationsUrl) {
    context.addIssue({ code:'custom',path:['MIGRATIONS_DATABASE_URL'],message:'A direct PostgreSQL URL is required for migrations when DATABASE_URL uses a transaction pooler.' });
  }
  if (migrationsUrl && databaseHost(migrationsUrl).includes('-pooler.')) {
    context.addIssue({ code:'custom',path:['MIGRATIONS_DATABASE_URL'],message:'Use the direct (unpooled) PostgreSQL URL for migrations.' });
  }
  if (value.NODE_ENV === 'production' && !value.APP_ORIGIN.startsWith('https://')) {
    context.addIssue({ code: 'custom', path: ['APP_ORIGIN'], message: 'Production requires HTTPS.' });
  }
  if (value.NODE_ENV === 'production' && value.ADDITIONAL_APP_ORIGINS.some((origin) => !origin.startsWith('https://'))) {
    context.addIssue({ code:'custom',path:['ADDITIONAL_APP_ORIGINS'],message:'Production application origins require HTTPS.' });
  }
  if (value.NODE_ENV === 'production' && value.EVIDENCE_STORAGE_PROVIDER === 's3' && (!value.S3_ENDPOINT.startsWith('https://') || !value.S3_PUBLIC_ENDPOINT.startsWith('https://'))) {
    context.addIssue({ code:'custom',path:['S3_ENDPOINT'],message:'Production storage requires HTTPS.' });
  }
}));
