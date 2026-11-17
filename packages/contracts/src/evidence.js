import { z } from 'zod';

export const EVIDENCE_LIMITS = Object.freeze({ photo: 10 * 1024 * 1024, audio: 25 * 1024 * 1024 });
export const evidenceMimeSchema = z.enum(['image/jpeg', 'image/png', 'image/webp', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm']);
export const evidenceFileSchema = z.object({
  name: z.string().trim().min(1).max(180).refine((name) => !/[\u0000-\u001f/\\]/.test(name), 'Use a simple filename.'),
  mimeType: evidenceMimeSchema, size: z.number().int().positive().max(EVIDENCE_LIMITS.audio),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().refine((file) => file.size <= EVIDENCE_LIMITS[file.mimeType.startsWith('image/') ? 'photo' : 'audio'], 'File exceeds its size limit.');
export const reserveEvidenceSchema = evidenceFileSchema.safeExtend({ evidenceId: z.uuid(), mutationId: z.uuid() }).strict();
export const evidenceMutationSchema = z.object({ evidenceId: z.uuid(), mutationId: z.uuid(), baseVersion: z.number().int().min(1).max(2147483646) }).strict();
export const evidenceSnapshotSchema = evidenceFileSchema.safeExtend({ id: z.uuid(), kind: z.enum(['photo', 'audio']) }).strict();
export const evidenceSchema = evidenceSnapshotSchema.safeExtend({
  organizationId: z.uuid(), inspectionId: z.uuid(), createdBy: z.uuid(),
  status: z.enum(['staging', 'attached', 'removed']), processingStatus: z.enum(['pending', 'ready', 'failed']),
  createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
}).strict();
export const evidenceListSchema = z.object({ evidence: z.array(evidenceSchema) }).strict();
export const uploadResponseSchema = z.object({ url: z.url(), fields: z.record(z.string(), z.string()), expiresAt: z.iso.datetime() }).strict();
export const evidenceParamsSchema = z.object({ id: z.uuid(), evidenceId: z.uuid() }).strict();
export const jobPayloadSchema = z.object({ organizationId: z.uuid(), jobId: z.uuid() }).strict();
export const jobSchema = z.object({
  id: z.uuid(), organizationId: z.uuid(), inspectionId: z.uuid(), evidenceId: z.uuid().nullable(),
  kind: z.enum(['verify_evidence', 'cleanup_stage', 'cleanup_evidence', 'prepare_report']),
  status: z.enum(['queued', 'running', 'retry', 'completed', 'failed']), attempts: z.number().int().nonnegative(),
  summary: z.string().nullable(), sourceVersion: z.number().int().positive().nullable(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict();
export const jobsResponseSchema = z.object({ jobs: z.array(jobSchema) }).strict();
export const archiveParamsSchema = z.object({ id: z.uuid(), jobId: z.uuid() }).strict();
export const reportJobDataSchema = z.object({ sourceVersion: z.number().int().positive() }).strict();
export const reportJobResultSchema = reportJobDataSchema.extend({ summary: z.string().max(2000), html: z.string().max(200000) }).strict();
export const verificationResultSchema = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().positive(), mimeType: evidenceMimeSchema }).strict();
