import { z } from 'zod';
import { INSPECTION_STATUSES } from './constants.js';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const analyticsQuerySchema = z.object({
  days: z.enum(['7', '30', '90']).default('30'), assetId: z.uuid().optional(),
}).strict();
export const analyticsSchema = z.object({
  scope: z.enum(['workspace', 'assigned']), days: z.number().int().min(7).max(90),
  since: z.iso.datetime(), asOf: z.iso.datetime(),
  assets: z.object({ total: count, active: count, archived: count }).strict(),
  inspections: z.object({ total: count, failedChecks: count,
    byStatus: z.object(Object.fromEntries(Object.values(INSPECTION_STATUSES).map((status) => [status, count]))).strict(),
    averageSubmissionHours: z.number().nonnegative().nullable(),
  }).strict(),
  activity: z.array(z.object({ date: z.iso.date(), created: count, submitted: count }).strict()).max(90),
  byAsset: z.array(z.object({ id: z.uuid(), code: z.string(), name: z.string(), status: z.enum(['active', 'archived']),
    inspections: count, submitted: count, approved: count, failedChecks: count }).strict()).max(50),
}).strict();
