import Dexie from 'dexie';
import { workspaceSchema, cachedInspectionSchema, workingCopySchema, outboxEntrySchema, inspectionSchema, localEvidenceSchema,localBlobSchema,evidenceFileSchema,evidenceMutationSchema } from '@fieldsync/contracts';
import { initialCopy, localChange, prepareRequest, acknowledge, pauseRequest, resolvedChange, editableStates } from './state.js';

export class OfflineStore {
  constructor(owner) {
    this.owner = workspaceSchema.parse(owner);
    this.name = `fieldsync:${owner.organizationId}:${owner.userId}`;
    this.db = new Dexie(this.name);
    this.db.version(1).stores({ records: 'id', workingCopies: 'id', outbox: '++sequence,&mutationId,inspectionId,status' });
    this.db.version(2).stores({ files:'id,inspectionId',blobs:'id' });
  }
  validate(schema, row) {
    const value = schema.parse(row);
    if (value.organizationId !== this.owner.organizationId || value.userId !== this.owner.userId) throw new Error('Local record belongs to another workspace.');
    return value;
  }
  async snapshot(id) {
    return this.db.transaction('r', this.db.tables, async () => {
      const records = (await this.db.records.toArray()).map((row) => this.validate(cachedInspectionSchema, row));
      const copies = (await this.db.workingCopies.toArray()).map((row) => this.validate(workingCopySchema, row));
      const queue = (await this.db.outbox.toArray()).map((row) => this.validate(outboxEntrySchema, row));
      const files = (await this.db.files.toArray()).map((row) => this.validate(localEvidenceSchema,row));
      return { records, copies, queue, files, record: records.find((row) => row.id === id), copy: copies.find((row) => row.id === id) };
    });
  }
  async cache(inspection, detail = null) {
    inspection = inspectionSchema.parse(inspection);
    if (inspection.organizationId !== this.owner.organizationId || inspection.assignedTo !== this.owner.userId) throw new Error('Assignment belongs to another workspace.');
    const cache = async (canRefreshCopy) => this.db.transaction('rw', this.db.tables, async () => {
      const previous = await this.db.records.get(inspection.id);
      if (previous && this.validate(cachedInspectionSchema, previous).inspection.version > inspection.version) return;
      const history = detail ?? (previous?.inspection.version === inspection.version ? previous.detail : null);
      await this.db.records.put(this.validate(cachedInspectionSchema, { ...this.owner, id: inspection.id, inspection, detail: history, unavailable: false }));
      const queue = await this.db.outbox.where('inspectionId').equals(inspection.id).count();
      const stored = await this.db.workingCopies.get(inspection.id);
      const copy = stored && this.validate(workingCopySchema, stored);
      if (!copy || (!queue && canRefreshCopy)) await this.db.workingCopies.put({ ...initialCopy(this.owner, inspection),
        generation: copy?.generation ?? 0, acknowledgedGeneration: copy?.generation ?? 0 });
      else if (!editableStates.includes(inspection.status) && inspection.version > copy.base.version) {
        await this.db.workingCopies.put({ ...copy, blocked: 'This inspection is now read-only. Your local work is retained.' });
      }
    });
    // A pull must never silently rebase a visible editor between a keystroke and
    // its transaction. Only refresh clean copies while no tab holds the editor lock.
    if (navigator.locks) await navigator.locks.request(`${this.name}:editor:${inspection.id}`, { ifAvailable: true }, (lock) => cache(!!lock));
    else await cache(false);
  }
  async unavailable(id) {
    await this.db.transaction('rw', this.db.records, this.db.workingCopies, async () => {
      const row = await this.db.records.get(id);
      if (row) await this.db.records.put({ ...this.validate(cachedInspectionSchema, row), unavailable: true });
      const copy = await this.db.workingCopies.get(id);
      if (copy) await this.db.workingCopies.put({ ...this.validate(workingCopySchema, copy), blocked: 'Assignment is no longer available. Your local work is retained.' });
    });
  }
  async transition(id, change, record = null) {
    return this.db.transaction('rw', this.db.tables, async () => {
      const copy = this.validate(workingCopySchema, await this.db.workingCopies.get(id));
      const queue = (await this.db.outbox.where('inspectionId').equals(id).sortBy('sequence')).map((row) => this.validate(outboxEntrySchema, row));
      const next = change(copy, queue);
      await this.db.workingCopies.put(this.validate(workingCopySchema, next.copy));
      const retained = new Set(next.queue.map((entry) => entry.mutationId));
      for (const old of queue) if (!retained.has(old.mutationId)) await this.db.outbox.delete(old.sequence);
      for (const row of next.queue) await this.db.outbox.put(this.validate(outboxEntrySchema, row));
      if (record) {
        const previous = await this.db.records.get(id);
        if (!previous || this.validate(cachedInspectionSchema, previous).inspection.version <= record.version) {
          await this.db.records.put(this.validate(cachedInspectionSchema, { ...this.owner, id, inspection: record, detail: null, unavailable: false }));
        }
      }
      return next;
    });
  }
  save(id, content, action = 'save', expected = null) {
    if (expected) this.validate(workingCopySchema, expected);
    return this.transition(id, (copy, queue) => localChange(copy, queue, content, action, undefined, expected));
  }
  prepare(entry) { return this.transition(entry.inspectionId, (copy, queue) => prepareRequest(copy, queue, entry.sequence)); }
  pause(entry, message, remote) { return this.transition(entry.inspectionId, (copy, queue) => pauseRequest(copy, queue, entry.sequence, message, remote)); }
  defer(entry, message) {
    return this.transition(entry.inspectionId, (copy, queue) => ({ copy,
      queue: queue.map((row) => row.mutationId === entry.mutationId ? { ...row, error: message } : row) }));
  }
  async ack(entry, response) {
    await this.db.transaction('rw',this.db.tables,async () => {
      await this.transition(entry.inspectionId, (copy, queue) => acknowledge(copy, queue, entry.mutationId, response), response);
      if (entry.action==='attach') {
        const row=await this.db.files.get(entry.body.evidenceId);
        if(row) await this.db.files.put({ ...this.validate(localEvidenceSchema,row),status:'synced' });
        await this.db.blobs.delete(entry.body.evidenceId);
      } else if(entry.action==='remove') { await this.db.files.delete(entry.body.evidenceId); await this.db.blobs.delete(entry.body.evidenceId); }
    });
  }
  async resolve(id, remote, content, action, generation) {
    return this.db.transaction('rw', this.db.tables, async () => {
      const before = (await this.db.outbox.where('inspectionId').equals(id).toArray()).map((row) => this.validate(outboxEntrySchema, row));
      const result = await this.transition(id, (copy, queue) => {
        if (!copy.conflict || copy.conflict.remote.version !== remote.version) throw new Error('The remote version changed. Review the comparison again.');
        return resolvedChange(copy, queue, remote, content, action, generation);
      }, remote);
      const retained = new Set(result.queue.filter((entry) => ['attach', 'remove'].includes(entry.action)).map((entry) => entry.body.evidenceId));
      for (const entry of before) {
        if (!['attach', 'remove'].includes(entry.action) || retained.has(entry.body.evidenceId)) continue;
        if (entry.action === 'attach') {
          const row = await this.db.files.get(entry.body.evidenceId);
          if (row) await this.db.files.put({ ...this.validate(localEvidenceSchema, row), status: 'synced' });
        } else await this.db.files.delete(entry.body.evidenceId);
        await this.db.blobs.delete(entry.body.evidenceId);
      }
      return result;
    });
  }
  async entries() { return (await this.snapshot()).queue; }
  async attachFile(id,file) {
    if (!(file instanceof Blob)) throw new Error('Choose a photo or audio file.');
    evidenceFileSchema.parse({ name:file.name,mimeType:file.type,size:file.size,sha256:'0'.repeat(64) });
    // Hash outside the IndexedDB transaction. Store one Blob, never a base64 copy
    // in working copies, snapshots, or each frozen replay attempt.
    const digest=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());
    const metadata=evidenceFileSchema.parse({ name:file.name,mimeType:file.type,size:file.size,sha256:[...new Uint8Array(digest)].map((byte)=>byte.toString(16).padStart(2,'0')).join('') });
    const estimate=await navigator.storage?.estimate?.();
    if(estimate?.quota && estimate.quota-estimate.usage<file.size*1.2) throw new Error('Device storage is nearly full. Free space and retry; the selected file is retained.');
    return this.db.transaction('rw',this.db.tables,async () => {
      const copy=this.validate(workingCopySchema,await this.db.workingCopies.get(id));
      const queue=(await this.db.outbox.where('inspectionId').equals(id).toArray()).map((row)=>this.validate(outboxEntrySchema,row));
      if(!mayEdit(copy,queue) || copy.conflict) throw new Error('Review the current assignment before attaching files.');
      const files=(await this.db.files.toArray()).map((row) => this.validate(localEvidenceSchema, row));
      const attached = new Set(copy.base.evidence.map((row) => row.id));
      for (const entry of queue) {
        if (entry.action === 'attach') attached.add(entry.body.evidenceId);
        if (entry.action === 'remove') attached.delete(entry.body.evidenceId);
      }
      if (attached.size >= 50) throw new Error('An inspection supports at most 50 attachments. Remove or sync existing evidence first.');
      if(files.filter((row)=>row.status==='queued').reduce((sum,row)=>sum+row.size,0)+file.size>200*1024*1024) throw new Error('The offline file queue is full. Sync existing files first.');
      const evidenceId=crypto.randomUUID(),mutationId=crypto.randomUUID();
      await this.db.files.put(this.validate(localEvidenceSchema,{ ...this.owner,...metadata,id:evidenceId,inspectionId:id,reserveMutationId:crypto.randomUUID(),status:'queued' }));
      await this.db.blobs.put(this.validate(localBlobSchema,{ ...this.owner,id:evidenceId,blob:file }));
      await this.db.workingCopies.put({ ...copy,generation:copy.generation+1,updatedAt:new Date().toISOString() });
      await this.db.outbox.add(this.validate(outboxEntrySchema,{ ...this.owner,mutationId,inspectionId:id,action:'attach',
        body:evidenceMutationSchema.parse({ evidenceId,mutationId,baseVersion:copy.base.version }),base:copy.base,generation:copy.generation+1,status:'pending',attemptedAt:null,error:null }));
      return evidenceId;
    });
  }
  async file(id) {
    const metadata=this.validate(localEvidenceSchema,await this.db.files.get(id));
    const bytes=this.validate(localBlobSchema,await this.db.blobs.get(id));
    if(bytes.blob.size!==metadata.size) throw new Error('The local file size changed. Your file is retained.');
    return { metadata,blob:bytes.blob };
  }
  removeFile(id,evidenceId) {
    return this.db.transaction('rw',this.db.tables,async () => {
      const copy=this.validate(workingCopySchema,await this.db.workingCopies.get(id));
      const queue=(await this.db.outbox.where('inspectionId').equals(id).toArray()).map((row)=>this.validate(outboxEntrySchema,row));
      if(!mayEdit(copy,queue) || copy.conflict) throw new Error('Review the assignment before removing evidence.');
      const pending=queue.find((entry)=>entry.action==='attach' && entry.body.evidenceId===evidenceId);
      if(pending?.status==='pending') {
        await this.db.outbox.delete(pending.sequence); await this.db.files.delete(evidenceId); await this.db.blobs.delete(evidenceId); return;
      }
      if(pending) throw new Error('This upload has been attempted. Sync or review it before removing it.');
      if(!copy.base.evidence.some((file)=>file.id===evidenceId)) throw new Error('Evidence is not attached to this inspection.');
      if(queue.some((entry)=>entry.action==='remove' && entry.body.evidenceId===evidenceId)) return;
      const mutationId=crypto.randomUUID();
      await this.db.outbox.add(this.validate(outboxEntrySchema,{ ...this.owner,mutationId,inspectionId:id,action:'remove',body:{ evidenceId,mutationId,baseVersion:copy.base.version },
        base:copy.base,generation:copy.generation+1,status:'pending',attemptedAt:null,error:null }));
      await this.db.workingCopies.put({ ...copy,generation:copy.generation+1,updatedAt:new Date().toISOString() });
    });
  }
}

export function mayEdit(copy, queue) {
  return copy && editableStates.includes(copy.base.status) && !copy.blocked
    && !queue.some((entry) => entry.inspectionId === copy.id && entry.action === 'submit' && !['conflict', 'blocked'].includes(entry.status));
}
