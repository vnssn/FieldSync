import { z } from 'zod';
import { ASSET_STATUSES, ASSET_EVENT_TYPES } from './constants.js';

const metadataShape = {
  code: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(160),
  category: z.string().trim().min(1).max(100),
  location: z.string().trim().min(1).max(240),
};
export const createAssetSchema = z.object(metadataShape).strict();
export const updateAssetSchema = z.object({
  ...createAssetSchema.partial().shape,
  status: z.enum(Object.values(ASSET_STATUSES)).optional(),
  baseVersion: z.number().int().min(1).max(2147483646),
}).strict().refine((value) => Object.keys(value).some((key) => key !== 'baseVersion'),
  'Provide at least one asset field to update.');

export const assetSchema = z.object({
  id: z.uuid(), organizationId: z.uuid(), ...metadataShape,
  status: z.enum(Object.values(ASSET_STATUSES)),
  version: z.number().int().positive(), createdBy: z.uuid(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict();

const changeSchema = z.object({ before: z.string().nullable(), after: z.string() }).strict();
export const assetChangesSchema = z.object({
  code: changeSchema.optional(), name: changeSchema.optional(),
  category: changeSchema.optional(), location: changeSchema.optional(), status: changeSchema.optional(),
}).strict();
export const assetEventSchema = z.object({
  id: z.uuid(), organizationId: z.uuid(), assetId: z.uuid(), actorUserId: z.uuid(),
  actorName: z.string(), eventType: z.enum(Object.values(ASSET_EVENT_TYPES)),
  changes: assetChangesSchema, createdAt: z.iso.datetime(),
}).strict();
export const assetDetailSchema = z.object({ asset: assetSchema, events: z.array(assetEventSchema) }).strict();
export const assetsResponseSchema = z.object({ assets: z.array(assetSchema) }).strict();
export const assetListQuerySchema = z.object({
  status: z.enum(['active', 'archived', 'all']).default('active'),
  q: z.string().trim().max(120).default(''),
}).strict();
export const assetIdParamsSchema = z.object({ id: z.uuid() }).strict();
