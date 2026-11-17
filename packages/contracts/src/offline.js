import { z } from 'zod';
import { authResponseSchema } from './auth.js';
import { inspectionSchema, inspectionDetailSchema, saveInspectionSchema } from './inspections.js';
import { evidenceFileSchema,evidenceMutationSchema } from './evidence.js';

export const workspaceSchema = z.object({ organizationId: z.uuid(), userId: z.uuid() }).strict();
const owner = workspaceSchema.shape;
export const offlineContentSchema = z.object({
  answers: z.array(z.object({ itemId: z.uuid(), outcome: z.enum(['pass', 'fail', 'not_applicable']).nullable(),
    notes: z.string().max(1000) }).strict()).max(50)
    .refine((answers) => new Set(answers.map((answer) => answer.itemId)).size === answers.length, 'Answer IDs must be unique.'),
  reportText: z.string().max(10000),
}).strict();
export const cachedInspectionSchema = z.object({
  ...owner, id: z.uuid(), inspection: inspectionSchema, detail: inspectionDetailSchema.nullable(), unavailable: z.boolean(),
}).strict().refine((row) => row.inspection.id === row.id && row.inspection.organizationId === row.organizationId && row.inspection.assignedTo === row.userId
  && (!row.detail || (row.detail.inspection.id === row.id && row.detail.inspection.organizationId === row.organizationId
    && row.detail.events.every((event) => event.organizationId === row.organizationId && event.resourceId === row.id)
    && row.detail.revisions.every((revision) => revision.organizationId === row.organizationId && revision.inspectionId === row.id
      && revision.snapshot.organizationId === row.organizationId && revision.snapshot.id === row.id))), 'Cached references must belong to this workspace.');
export const workingCopySchema = z.object({
  ...owner, id: z.uuid(), base: inspectionSchema, content: offlineContentSchema,
  generation: z.number().int().nonnegative(), acknowledgedGeneration: z.number().int().nonnegative(),
  conflict: z.object({ base: inspectionSchema, remote: inspectionSchema }).strict().nullable(),
  blocked: z.string().nullable(), updatedAt: z.iso.datetime(),
}).strict().refine((row) => row.base.id === row.id && row.base.organizationId === row.organizationId && row.base.assignedTo === row.userId
  && row.acknowledgedGeneration <= row.generation
  && (!row.conflict || [row.conflict.base, row.conflict.remote].every((record) => record.id === row.id && record.organizationId === row.organizationId))
  && (!row.conflict || row.conflict.remote.assignedTo === row.userId)
  && row.content.answers.length === row.base.template.items.length
  && row.content.answers.every((answer) => row.base.template.items.some((item) => item.id === answer.itemId)), 'Working copy references must match.');
export const outboxEntrySchema = z.object({
  ...owner, sequence: z.number().int().positive().optional(), mutationId: z.uuid(), inspectionId: z.uuid(),
  action: z.enum(['save', 'submit', 'attach', 'remove']), body: z.union([saveInspectionSchema,evidenceMutationSchema]), base: inspectionSchema,
  generation: z.number().int().nonnegative(), status: z.enum(['pending', 'attempted', 'conflict', 'blocked']),
  attemptedAt: z.iso.datetime().nullable(), error: z.string().nullable(),
}).strict().refine((entry) => entry.mutationId === entry.body.mutationId && entry.inspectionId === entry.base.id
  && entry.base.organizationId === entry.organizationId && entry.base.assignedTo === entry.userId
  && (['attach','remove'].includes(entry.action) ? evidenceMutationSchema.safeParse(entry.body).success
    : saveInspectionSchema.safeParse(entry.body).success && entry.body.answers.length === entry.base.template.items.length
      && entry.body.answers.every((answer) => entry.base.template.items.some((item) => item.id === answer.itemId))),
  'Outbox identity must match its frozen request.');
export const localEvidenceSchema = evidenceFileSchema.safeExtend({ ...owner,id:z.uuid(),inspectionId:z.uuid(),reserveMutationId:z.uuid(),
  status:z.enum(['queued','synced']) }).strict();
export const localBlobSchema = z.object({ ...owner,id:z.uuid(),blob:z.custom((value) => typeof Blob !== 'undefined' && value instanceof Blob) }).strict();
export const offlineSessionSchema = z.object({
  session: authResponseSchema.nullable(), expired: z.boolean(), loggedOut: z.boolean(), pendingLogout: z.boolean(),
}).strict();
