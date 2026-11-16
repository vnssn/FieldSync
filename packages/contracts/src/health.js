import { z } from 'zod';

export const DependencyHealthSchema = z.object({
  status: z.enum(['up', 'down']),
  latencyMs: z.number().finite().nonnegative(),
}).strict();

export const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  service: z.literal('fieldsync-api'),
  timestamp: z.iso.datetime(),
  uptimeSeconds: z.number().int().nonnegative(),
  dependencies: z.object({
    postgres: DependencyHealthSchema,
    redis: DependencyHealthSchema,
  }).strict(),
}).strict().superRefine((value, context) => {
  const allUp = Object.values(value.dependencies).every((dependency) => dependency.status === 'up');
  if ((value.status === 'ok') !== allUp) {
    context.addIssue({
      code: 'custom',
      path: ['status'],
      message: 'Overall health must agree with dependency health.',
    });
  }
});

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
  }).strict(),
  requestId: z.uuid(),
}).strict();
