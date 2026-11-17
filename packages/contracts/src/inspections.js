import { z } from 'zod';
import { INSPECTION_STATUSES } from './constants.js';
import { evidenceSnapshotSchema } from './evidence.js';

const version = z.number().int().min(1).max(2147483647);
const mutation = { mutationId: z.uuid() };
const update = { ...mutation, baseVersion: version.max(2147483646) };
const note = z.string().trim().max(2000);
export const checklistItemSchema = z.object({ id: z.uuid(), label: z.string().trim().min(1).max(240) }).strict();
const items = z.array(checklistItemSchema).min(1).max(50)
  .refine((value) => new Set(value.map((item) => item.id)).size === value.length, 'Checklist item IDs must be unique.');
const templateFields = { name: z.string().trim().min(1).max(160), description: z.string().trim().max(2000), items };
export const createTemplateSchema = z.object({ ...templateFields, ...mutation }).strict();
export const updateTemplateSchema = z.object({ ...templateFields, status: z.enum(['active', 'archived']), ...update }).strict();
export const templateSnapshotSchema = z.object({ id: z.uuid(), ...templateFields, version }).strict();
export const templateSchema = templateSnapshotSchema.extend({
  organizationId: z.uuid(), status: z.enum(['active', 'archived']), createdBy: z.uuid(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict();
export const templatesResponseSchema = z.object({ templates: z.array(templateSchema) }).strict();
export const templateListQuerySchema = z.object({ status: z.enum(['active', 'archived', 'all']).default('active') }).strict();
export const resourceIdParamsSchema = z.object({ id: z.uuid() }).strict();
export const checklistAnswerSchema = z.object({
  itemId: z.uuid(), outcome: z.enum(['pass', 'fail', 'not_applicable']).nullable(), notes: z.string().trim().max(1000),
}).strict();
const answers = z.array(checklistAnswerSchema).max(50)
  .refine((value) => new Set(value.map((answer) => answer.itemId)).size === value.length, 'Answer item IDs must be unique.');
const content = { answers, reportText: z.string().trim().max(10000) };
export const createInspectionSchema = z.object({ assetId: z.uuid(), templateId: z.uuid(), assignedTo: z.uuid(), ...mutation }).strict();
export const saveInspectionSchema = z.object({ ...content, ...update }).strict();
export const reassignInspectionSchema = z.object({ assignedTo: z.uuid(), ...update }).strict();
export const cancelInspectionSchema = z.object({ note, ...update }).strict();
export const reviewInspectionSchema = z.object({ decision: z.enum(['approve', 'request_changes']), note, ...update }).strict()
  .refine((value) => value.decision !== 'request_changes' || value.note.length > 0, 'Explain the changes requested.');
export const inspectionSchema = z.object({
  id: z.uuid(), organizationId: z.uuid(), assetId: z.uuid(), templateId: z.uuid(), assignedTo: z.uuid(),
  asset: z.object({ id: z.uuid(), code: z.string(), name: z.string(), category: z.string(), location: z.string() }).strict(),
  template: templateSnapshotSchema,
  worker: z.object({ id: z.uuid(), name: z.string(), email: z.email() }).strict(),
  ...content, evidence: z.array(evidenceSnapshotSchema).max(50).default([]), status: z.enum(Object.values(INSPECTION_STATUSES)), version,
  reviewNote: note, submittedAt: z.iso.datetime().nullable(), approvedAt: z.iso.datetime().nullable(),
  approvedBy: z.uuid().nullable(), createdBy: z.uuid(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict().refine((value) => value.assetId === value.asset.id && value.templateId === value.template.id
  && value.assignedTo === value.worker.id, 'Inspection snapshots must match their references.');
export const inspectionsResponseSchema = z.object({ inspections: z.array(inspectionSchema) }).strict();
export const inspectionListQuerySchema = z.object({ status: z.enum(['all', ...Object.values(INSPECTION_STATUSES)]).default('all') }).strict();
export const auditEventSchema = z.object({
  id: z.uuid(), organizationId: z.uuid(), resourceId: z.uuid(), actorUserId: z.uuid(), actorName: z.string(),
  eventType: z.enum(['created', 'updated', 'saved', 'submitted', 'changes_requested', 'approved', 'reassigned', 'cancelled', 'evidence_attached', 'evidence_removed']),
  version, details: z.object({
    changes: z.record(z.string(), z.object({ before: z.unknown(), after: z.unknown() }).strict()), note,
  }).strict(), createdAt: z.iso.datetime(),
}).strict();
export const inspectionRevisionSchema = z.object({
  id: z.uuid(), organizationId: z.uuid(), inspectionId: z.uuid(), version,
  snapshot: inspectionSchema, createdBy: z.uuid(), createdAt: z.iso.datetime(),
}).strict();
export const templateDetailSchema = z.object({ template: templateSchema, events: z.array(auditEventSchema) }).strict();
export const inspectionDetailSchema = z.object({
  inspection: inspectionSchema, events: z.array(auditEventSchema), revisions: z.array(inspectionRevisionSchema),
}).strict();
