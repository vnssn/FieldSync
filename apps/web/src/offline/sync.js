import { authResponseSchema, inspectionDetailSchema, inspectionSchema } from '@fieldsync/contracts';
import { sameContent, contentOf } from './state.js';
import { replayEvidence } from './evidence.js';

// The caller holds a workspace lock and session lock. The store commits an immutable
// attempt before dispatch, so a lost response always retries the exact same receipt.
export async function flushOutbox({ store, request, active = () => true, onExpired = () => {}, upload }) {
  if (!active()) return;
  let session;
  try { session = await request('/auth/me', { schema: authResponseSchema }); }
  catch (error) { if (error.status === 401) { onExpired(); return; } throw error; }
  if (!active() || session.organization.id !== store.owner.organizationId || session.user.id !== store.owner.userId || session.user.role !== 'worker') return;
  const paused = new Set();
  for (const entry of await store.entries()) {
    if (!active()) return;
    if (paused.has(entry.inspectionId)) continue;
    if (['conflict', 'blocked'].includes(entry.status)) { paused.add(entry.inspectionId); continue; }
    const { request: attempt } = await store.prepare(entry);
    if (!attempt || !active()) continue;
    try {
      const response = ['attach','remove'].includes(attempt.action) ? await replayEvidence({ store,request,attempt,upload,active }) : await request(`/inspections/${attempt.inspectionId}${attempt.action === 'submit' ? '/submit' : ''}`, {
        method: attempt.action === 'submit' ? 'POST' : 'PATCH', body: attempt.body, schema: inspectionSchema,
      });
      await store.ack(attempt, response);
    } catch (error) {
      if (!active()) return;
      if (error.status === 401) { onExpired(); return; }
      if (!error.status || error.status >= 500) throw error;
      if (error.code === 'EVIDENCE_PROCESSING') {
        await store.defer(attempt, error.message);
        paused.add(attempt.inspectionId);
        continue;
      }
      if (error.code === 'VERSION_CONFLICT' || error.code === 'NO_CHANGES') {
        try {
          const { inspection: remote } = await request(`/inspections/${attempt.inspectionId}`, { schema: inspectionDetailSchema });
          if (error.code === 'NO_CHANGES' && remote.assignedTo === store.owner.userId && remote.status === 'draft'
            && remote.version === attempt.body.baseVersion && sameContent(contentOf(remote), attempt.body)) {
            await store.ack(attempt, remote); continue;
          }
          await store.pause(attempt, error.message, remote);
        } catch (readError) {
          if (readError.status === 401) { onExpired(); return; }
          if (!readError.status || readError.status >= 500) throw readError;
          await store.pause(attempt, 'Assignment is no longer accessible. Local work is retained.');
        }
      } else await store.pause(attempt, `${error.message} Local work is retained.`);
      paused.add(attempt.inspectionId);
    }
  }
}
