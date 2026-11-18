import { z } from 'zod';
import { saveInspectionSchema } from './inspections.js';

export const aiKindSchema = z.enum(['image', 'voice', 'report']);
export const aiOutputSchema = z.object({
  text: z.string().max(10000), transcript: z.string().max(10000),
  findings: z.array(z.object({ itemId: z.uuid(), notes: z.string().max(1000) }).strict()).max(50)
    .refine((rows) => new Set(rows.map((row) => row.itemId)).size === rows.length, 'Finding item IDs must be unique.'),
  warnings: z.array(z.string().max(500)).max(10),
}).strict();
export const requestAiSchema = z.object({
  kind: aiKindSchema, evidenceId: z.uuid().nullable().default(null),
  mutationId: z.uuid(), baseVersion: z.number().int().min(1).max(2147483646),
}).strict().refine((value) => value.kind === 'report' ? value.evidenceId === null : value.evidenceId !== null,
  'Choose evidence for image or voice assistance only.');
export const reviewAiSchema = z.discriminatedUnion('decision', [
  saveInspectionSchema.extend({ decision: z.literal('apply'), confirmed: z.literal(true) }).strict(),
  z.object({ decision: z.literal('reject'), confirmed: z.literal(true), mutationId: z.uuid(),
    baseVersion: z.number().int().min(1).max(2147483646) }).strict(),
]);
export const aiParamsSchema = z.object({ id: z.uuid(), artifactId: z.uuid() }).strict();
export const aiReviewSchema = z.object({
  decision: z.enum(['apply', 'reject']), reviewedBy: z.uuid(), reviewerName: z.string(),
  reviewedAt: z.iso.datetime(), appliedVersion: z.number().int().positive().nullable(),
  confirmed: saveInspectionSchema.omit({ mutationId: true, baseVersion: true }).nullable(),
}).strict();
export const aiArtifactSchema = z.object({
  id: z.uuid(), organizationId: z.uuid(), inspectionId: z.uuid(), evidenceId: z.uuid().nullable(),
  kind: aiKindSchema, sourceVersion: z.number().int().positive(), requestedBy: z.uuid(),
  status: z.enum(['queued', 'ready', 'failed']), provider: z.string().max(100).nullable(),
  model: z.string().max(150).nullable(), mode: z.enum(['provider', 'fallback']).nullable(),
  fallbackReason: z.enum(['disabled', 'missing_key', 'provider_error']).nullable(),
  promptVersion: z.string().max(100), providerRequestId: z.string().max(200).nullable(),
  original: aiOutputSchema.nullable(), review: aiReviewSchema.nullable(),
  createdAt: z.iso.datetime(), completedAt: z.iso.datetime().nullable(),
}).strict();
export const aiListSchema = z.object({ artifacts: z.array(aiArtifactSchema).max(200), providerEnabled: z.boolean() }).strict();
