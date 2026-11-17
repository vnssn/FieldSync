import { randomUUID } from 'node:crypto';
import { initialCopy, localChange, prepareRequest, acknowledge, pauseRequest, resolvedChange } from '../../apps/web/src/offline/state.js';
import { outboxEntrySchema, workingCopySchema } from '@fieldsync/contracts';

export const owner = { organizationId: randomUUID(), userId: randomUUID() };
export function inspection(overrides = {}) {
  const assetId = randomUUID(), templateId = randomUUID();
  const now = new Date().toISOString();
  return {
    id: randomUUID(), organizationId: owner.organizationId, assignedTo: owner.userId, assetId, templateId,
    asset: { id: assetId, code: 'PUMP', name: 'Pump', category: '', location: '' },
    template: { id: templateId, name: 'Safety', description: '', version: 1, items: [{ id: randomUUID(), label: 'Pressure' }] },
    worker: { id: owner.userId, name: 'Worker', email: 'worker@example.test' },
    answers: [], reportText: '', status: 'assigned', version: 1, reviewNote: '', submittedAt: null,
    approvedAt: null, approvedBy: null, createdBy: randomUUID(), createdAt: now, updatedAt: now, ...overrides,
  };
}
// Core sync tests use the same pure transitions as Dexie, without adding a fake
// IndexedDB dependency. The browser verification exercises actual IndexedDB.
export class MemoryStore {
  constructor(records, workspace = owner) {
    this.owner = workspace; this.copies = new Map(records.map((row) => [row.id, initialCopy(workspace, row)]));
    this.queue = []; this.sequence = 0;
  }
  transition(id, change) {
    const queue = this.queue.filter((entry) => entry.inspectionId === id);
    const result = change(this.copies.get(id), structuredClone(queue));
    const next = result.queue.map((entry) => outboxEntrySchema.parse({ ...entry, sequence: entry.sequence ?? ++this.sequence }));
    this.copies.set(id, workingCopySchema.parse(result.copy));
    this.queue = [...this.queue.filter((entry) => entry.inspectionId !== id), ...next].sort((a, b) => a.sequence - b.sequence);
    return result;
  }
  save(id, content, action = 'save') { return this.transition(id, (copy, queue) => localChange(copy, queue, content, action)); }
  prepare(entry) { return this.transition(entry.inspectionId, (copy, queue) => prepareRequest(copy, queue, entry.sequence)); }
  ack(entry, response) { return this.transition(entry.inspectionId, (copy, queue) => acknowledge(copy, queue, entry.mutationId, response)); }
  pause(entry, message, remote) { return this.transition(entry.inspectionId, (copy, queue) => pauseRequest(copy, queue, entry.sequence, message, remote)); }
  resolve(id, remote, content, action, generation) { return this.transition(id, (copy, queue) => resolvedChange(copy, queue, remote, content, action, generation)); }
  async entries() { return structuredClone(this.queue); }
}
export function identity(workspace = owner) {
  return { organization: { id: workspace.organizationId }, user: { id: workspace.userId, role: 'worker' } };
}
export function apiError(status, code) { return Object.assign(new Error(code), { status, code }); }
