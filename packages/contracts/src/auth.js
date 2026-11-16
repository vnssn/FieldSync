import { z } from 'zod';
import { ROLES } from './constants.js';

const nameSchema = z.string().trim().min(1).max(120);
const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());
export const passwordSchema = z.string().min(12).max(128);
export const organizationSchema = z.object({ id: z.uuid(), name: nameSchema }).strict();

export const registerOrgSchema = z.object({
  organizationName: nameSchema,
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
}).strict();

// Email is unique within an organization, so login must identify that organization.
export const loginSchema = z.object({
  organizationId: z.uuid(),
  email: emailSchema,
  password: passwordSchema,
}).strict();

export const createWorkerSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
}).strict();

export const userPublicSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  name: nameSchema,
  email: emailSchema,
  role: z.enum(Object.values(ROLES)),
  createdAt: z.iso.datetime(),
}).strict();

export const authResponseSchema = z.object({
  user: userPublicSchema,
  organization: organizationSchema,
}).strict().refine((value) => value.user.organizationId === value.organization.id,
  'User and organization must agree.');
export const usersResponseSchema = z.object({ users: z.array(userPublicSchema) }).strict();
export const emptyRequestSchema = z.object({}).strict();
