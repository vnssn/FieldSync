export const ROLES = Object.freeze({
  ADMIN: 'admin',
  WORKER: 'worker',
});

export const ASSET_STATUSES = Object.freeze({ ACTIVE: 'active', ARCHIVED: 'archived' });
export const ASSET_EVENT_TYPES = Object.freeze({
  CREATED: 'created', UPDATED: 'updated', ARCHIVED: 'archived', RESTORED: 'restored',
});

export const INSPECTION_STATUSES = Object.freeze({
  ASSIGNED: 'assigned',
  DRAFT: 'draft',
  SUBMITTED: 'submitted',
  CHANGES_REQUESTED: 'changes_requested',
  APPROVED: 'approved',
  CANCELLED: 'cancelled',
});

export const SYNC_STATUSES = Object.freeze({
  PENDING: 'pending',
  IN_FLIGHT: 'in_flight',
  SYNCED: 'synced',
  CONFLICT: 'conflict',
  BLOCKED: 'blocked',
});

export const JOB_STATUSES = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});
