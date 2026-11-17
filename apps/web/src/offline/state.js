import { offlineContentSchema, outboxEntrySchema, workingCopySchema, saveInspectionSchema, inspectionSchema, evidenceMutationSchema } from '@fieldsync/contracts';

export const editableStates = ['assigned', 'draft', 'changes_requested'];
export function contentOf(inspection) {
  return { reportText: inspection.reportText, answers: inspection.template.items.map((item) =>
    inspection.answers.find((answer) => answer.itemId === item.id) ?? { itemId: item.id, outcome: null, notes: '' }) };
}
function normalized(content) {
  return { reportText: content.reportText.trim(), answers: content.answers.map((answer) => ({
    itemId: answer.itemId, outcome: answer.outcome, notes: answer.notes.trim(),
  })) };
}
export function sameContent(left, right) {
  return JSON.stringify(normalized(left.template ? contentOf(left) : left)) === JSON.stringify(normalized(right.template ? contentOf(right) : right));
}
export function initialCopy(owner, inspection) {
  return workingCopySchema.parse({ ...owner, id: inspection.id, base: inspection, content: contentOf(inspection),
    generation: 0, acknowledgedGeneration: 0, conflict: null, blocked: null, updatedAt: new Date().toISOString() });
}
function validateContent(copy, content, action) {
  const parsed = offlineContentSchema.parse(content);
  const ids = copy.base.template.items.map((item) => item.id);
  if (parsed.answers.length !== ids.length || parsed.answers.some((answer) => !ids.includes(answer.itemId))) {
    throw new Error('Use the checklist belonging to this inspection.');
  }
  parsed.answers.sort((a, b) => ids.indexOf(a.itemId) - ids.indexOf(b.itemId));
  if (action === 'submit' && parsed.answers.some((answer) => !answer.outcome || (answer.outcome === 'fail' && !answer.notes.trim()))) {
    throw new Error('Answer every checklist item and explain failed checks before submitting.');
  }
  return parsed;
}
export function localChange(copy, queue, content, action, newId = () => crypto.randomUUID(), expected = null) {
  if (!editableStates.includes(copy.base.status) || copy.blocked) throw new Error('This inspection is read-only. Your local work is retained.');
  // Guard even the brief gap between acquiring an editor lock and its live-query
  // render. A server pull is not an acknowledgment of this device's intent.
  const remote = expected && expected.base.version !== copy.base.version
    && copy.acknowledgedGeneration <= expected.acknowledgedGeneration ? copy.base : null;
  if (remote) copy = { ...copy, base: expected.base };
  if (queue.some((entry) => entry.action === 'submit' && !['conflict', 'blocked'].includes(entry.status))) {
    throw new Error('Submission is already queued. Wait for sync or resolve the conflict.');
  }
  const next = { ...copy, content: validateContent(copy, content, action), generation: copy.generation + 1, updatedAt: new Date().toISOString() };
  const last = queue.at(-1);
  const body = saveInspectionSchema.parse({ ...next.content, baseVersion: copy.base.version,
    mutationId: last?.action === 'save' && last.status === 'pending' && action === 'save' ? last.mutationId : newId() });
  let entries = [...queue];
  if (last?.action === 'save' && last.status === 'pending' && action === 'save') {
    entries[entries.length - 1] = { ...last, body, generation: next.generation };
  } else if (!(action === 'save' && !remote && ((last?.action === 'save' && sameContent(last.body, body))
    || (!last && copy.base.status === 'draft' && sameContent(contentOf(copy.base), body))))) {
    entries.push(outboxEntrySchema.parse({ organizationId: copy.organizationId, userId: copy.userId,
      mutationId: body.mutationId, inspectionId: copy.id, action, body, base: copy.base, generation: next.generation,
      status: 'pending', attemptedAt: null, error: null }));
  }
  if (remote) {
    const paused = pauseRequest(next, entries, entries[0].sequence, 'A newer server version arrived. Review your retained edits.', remote);
    if (paused.copy.conflict) paused.copy.conflict.base = expected.base;
    return paused;
  }
  return { copy: workingCopySchema.parse(next), queue: entries };
}
export function prepareRequest(copy, queue, sequence) {
  const head = queue[0];
  if (!head || head.sequence !== sequence || ['conflict', 'blocked'].includes(head.status)) return { copy, queue, request: null };
  if (head.status === 'attempted') return { copy, queue, request: head };
  // Only unattempted requests can take the version returned by the preceding acknowledgment.
  const body = (['attach','remove'].includes(head.action) ? evidenceMutationSchema : saveInspectionSchema).parse({ ...head.body, baseVersion: copy.base.version });
  if (head.action === 'save' && copy.base.status === 'draft' && sameContent(contentOf(copy.base), body)) {
    return { copy: { ...copy, acknowledgedGeneration: Math.max(copy.acknowledgedGeneration, head.generation) }, queue: queue.slice(1), request: null };
  }
  const request = outboxEntrySchema.parse({ ...head, base: copy.base, body, status: 'attempted', attemptedAt: new Date().toISOString(), error: null });
  return { copy, queue: [request, ...queue.slice(1)], request };
}
export function acknowledge(copy, queue, mutationId, response) {
  const entry = queue.find((row) => row.mutationId === mutationId);
  if (!entry) return { copy, queue };
  const saved = inspectionSchema.parse(response);
  if (saved.id !== copy.id || saved.organizationId !== copy.organizationId || saved.assignedTo !== copy.userId) {
    throw new Error('The sync response belongs to another workspace.');
  }
  if (saved.version < copy.base.version) throw new Error('The sync response is older than the acknowledged version.');
  const next = { ...copy, base: saved, content: ['attach','remove'].includes(entry.action) ? copy.content : copy.generation === entry.generation ? contentOf(saved) : copy.content,
    acknowledgedGeneration: Math.max(copy.acknowledgedGeneration, entry.generation), updatedAt: new Date().toISOString() };
  return { copy: workingCopySchema.parse(next), queue: queue.filter((row) => row.mutationId !== mutationId) };
}
export function pauseRequest(copy, queue, sequence, message, remote = null) {
  const head = queue.find((row) => row.sequence === sequence);
  if (!head) return { copy, queue };
  const canMerge = remote && remote.assignedTo === copy.userId && editableStates.includes(remote.status);
  return { copy: workingCopySchema.parse({ ...copy,
    conflict: canMerge ? { base: head.base, remote } : null,
    blocked: canMerge ? null : message }),
  queue: queue.map((row) => row.sequence === sequence ? { ...row, status: canMerge ? 'conflict' : 'blocked', error: message } : row) };
}
export function resolvedChange(copy, queue, remote, content, action, generation, newId = () => crypto.randomUUID()) {
  remote=inspectionSchema.parse(remote);
  if (copy.generation !== generation) throw new Error('Your local copy changed. Review the comparison again.');
  if (remote.assignedTo !== copy.userId || !editableStates.includes(remote.status)) throw new Error('The current assignment is read-only. Local work is retained.');
  // Retain file intent through checklist merge. Failed attempts receive fresh IDs;
  // already-present remote membership is acknowledged instead of attached twice.
  const files = queue.filter((entry) => (entry.action==='attach' && !remote.evidence.some((file) => file.id===entry.body.evidenceId))
    || (entry.action==='remove' && remote.evidence.some((file) => file.id===entry.body.evidenceId))).map((entry) => {
    const mutationId=newId(); return { ...entry,mutationId,body:{ ...entry.body,mutationId,baseVersion:remote.version },
      base:remote,status:'pending',attemptedAt:null,error:null };
  });
  return localChange({ ...copy, base: remote, conflict: null, blocked: null }, files, content, action, newId);
}

// Merge only worker-owned fields. Assignment/status/approval always come from the server.
export function mergeContent(base, local, remote, choices = {}) {
  const before = contentOf(base);
  const theirs = contentOf(remote);
  const conflicts = [];
  function choose(key, label, original, ours, other) {
    if (ours === original) return other;
    if (other === original || ours === other) return ours;
    conflicts.push({ key, label, base: original, local: ours, remote: other });
    return choices[key] === 'remote' ? other : ours;
  }
  const content = { reportText: choose('reportText', 'Report summary', before.reportText, local.reportText, theirs.reportText),
    answers: remote.template.items.map((item) => {
      const b = before.answers.find((answer) => answer.itemId === item.id);
      const l = local.answers.find((answer) => answer.itemId === item.id);
      const r = theirs.answers.find((answer) => answer.itemId === item.id);
      if (!b || !l) throw new Error('The checklist changed. Keep your local copy and review the assignment.');
      return { itemId: item.id,
        outcome: choose(`${item.id}:outcome`, `${item.label} — outcome`, b.outcome, l.outcome, r.outcome),
        notes: choose(`${item.id}:notes`, `${item.label} — notes`, b.notes, l.notes, r.notes) };
    }) };
  return { content, conflicts, complete: conflicts.every((field) => ['local', 'remote'].includes(choices[field.key])) };
}
