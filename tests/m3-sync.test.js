import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { cachedInspectionSchema, workingCopySchema, outboxEntrySchema } from '@fieldsync/contracts';
import { contentOf, initialCopy, mergeContent, localChange } from '../apps/web/src/offline/state.js';
import { flushOutbox } from '../apps/web/src/offline/sync.js';
import { MemoryStore, owner, inspection, identity, apiError } from './helpers/offline.js';

function complete(row, text = 'Checked locally') { return { reportText: text, answers: row.template.items.map((item) => ({ itemId: item.id, outcome: 'pass', notes: '' })) }; }

test('M3 local contracts reject foreign references and preserve raw local text', () => {
  const row = inspection(), copy = initialCopy(owner, row);
  const result = localChange(copy, [], { ...contentOf(row), reportText: '  local text  ' }, 'save');
  assert.equal(result.copy.content.reportText, '  local text  ');
  assert.equal(result.queue[0].body.reportText, 'local text');
  assert.equal(workingCopySchema.safeParse({ ...copy, id: randomUUID() }).success, false);
  assert.equal(workingCopySchema.safeParse({ ...copy, organizationId: randomUUID() }).success, false);
  assert.equal(outboxEntrySchema.safeParse({ ...result.queue[0], userId: randomUUID() }).success, false);
  assert.equal(outboxEntrySchema.safeParse({ ...result.queue[0], mutationId: randomUUID() }).success, false);
  assert.equal(cachedInspectionSchema.safeParse({ ...owner, id: randomUUID(), inspection: row, detail: null, unavailable: false }).success, false);
});

test('M3 unattempted saves coalesce; submissions retain an ordered separate intent', () => {
  const row = inspection(), store = new MemoryStore([row]);
  store.save(row.id, complete(row, 'First')); const id = store.queue[0].mutationId;
  store.save(row.id, complete(row, 'Second')); store.save(row.id, complete(row, 'Second'), 'submit');
  assert.deepEqual(store.queue.map((entry) => entry.action), ['save', 'submit']);
  assert.equal(store.queue[0].mutationId, id);
  assert.equal(store.queue[0].body.reportText, 'Second');
  assert.throws(() => store.save(row.id, complete(row, 'Too late')), /Submission is already queued/);
});

test('M3 offline queue replay advances baseVersion from save to submission', async () => {
  const row = inspection(), store = new MemoryStore([row]); let remote = row; const sent = [];
  store.save(row.id, complete(row)); store.save(row.id, complete(row), 'submit');
  await flushOutbox({ store, request: async (path, options) => {
    if (path === '/auth/me') return identity();
    const head = store.queue[0]; assert.equal(head.status, 'attempted');
    assert.deepEqual(head.body, options.body); sent.push({ path, ...options.body });
    assert.equal(options.body.baseVersion, remote.version);
    remote = { ...remote, answers: options.body.answers, reportText: options.body.reportText, version: remote.version + 1,
      status: options.method === 'POST' ? 'submitted' : 'draft' }; return remote;
  } });
  assert.deepEqual(sent.map((entry) => entry.baseVersion), [1, 2]);
  assert.equal(remote.status, 'submitted'); assert.equal(store.queue.length, 0);
});

test('M3 a lost response retries a frozen receipt and acknowledges without losing newer edits', async () => {
  const row = inspection(), store = new MemoryStore([row]); const sent = []; let fail = true;
  store.save(row.id, complete(row, 'Original'));
  const request = async (path, options) => {
    if (path === '/auth/me') return identity();
    sent.push(structuredClone(options.body));
    if (fail) { fail = false; throw new TypeError('Network response lost'); }
    return { ...row, ...complete(row, options.body.reportText), status: 'draft', version: options.body.baseVersion + 1 };
  };
  await assert.rejects(flushOutbox({ store, request }), /Network response lost/);
  assert.equal(store.queue[0].status, 'attempted');
  const frozen = structuredClone(store.queue[0]);
  store.save(row.id, complete(row, 'Newer local edit'));
  assert.deepEqual(store.queue[0], frozen);
  await flushOutbox({ store, request });
  assert.deepEqual(sent[0], sent[1]); assert.equal(sent[2].baseVersion, 2);
  assert.equal(store.copies.get(row.id).content.reportText, 'Newer local edit'); assert.equal(store.queue.length, 0);
});

test('M3 an in-flight acknowledgment preserves newer content and pending intent', () => {
  const row = inspection(), store = new MemoryStore([row]);
  store.save(row.id, complete(row, 'First')); const attempt = store.prepare(store.queue[0]).request;
  store.save(row.id, complete(row, 'Second'));
  store.ack(attempt, { ...row, ...complete(row, 'First'), version: 2, status: 'draft' });
  assert.equal(store.copies.get(row.id).content.reportText, 'Second');
  assert.equal(store.copies.get(row.id).base.version, 2);
  assert.equal(store.queue.length, 1); assert.equal(store.prepare(store.queue[0]).request.body.baseVersion, 2);
});

test('M3 conflict pauses one inspection, preserves its submission, and permits unrelated work', async () => {
  const row = inspection(), other = inspection(), store = new MemoryStore([row, other]);
  const remote = { ...row, reportText: 'Remote edit', version: 2, status: 'draft' };
  store.save(row.id, complete(row, 'Local edit')); store.save(row.id, complete(row, 'Local edit'), 'submit');
  store.save(other.id, complete(other));
  const sent = [];
  await flushOutbox({ store, request: async (path, options) => {
    if (path === '/auth/me') return identity();
    if (!options.method) return { inspection: remote };
    sent.push(path);
    if (path.includes(row.id)) throw apiError(409, 'VERSION_CONFLICT');
    return { ...other, ...complete(other), version: 2, status: 'draft' };
  } });
  assert.equal(sent.length, 2); assert.equal(store.queue.length, 2);
  assert.equal(store.queue[0].status, 'conflict'); assert.equal(store.queue[1].action, 'submit');
  assert.equal(store.copies.get(row.id).content.reportText, 'Local edit');
  assert.equal(store.copies.get(row.id).conflict.base.version, 1);
  assert.equal(store.copies.get(row.id).conflict.remote.version, 2);
});

test('M3 three-way merge combines independent fields and requires explicit overlapping choices', () => {
  const row = inspection(); row.answers = complete(row, '').answers;
  const local = { ...contentOf(row), reportText: 'Local summary' };
  const remote = { ...row, answers: row.answers.map((answer) => ({ ...answer, notes: 'Remote note' })), version: 2 };
  let merged = mergeContent(row, local, remote);
  assert.equal(merged.complete, true); assert.equal(merged.content.reportText, 'Local summary');
  assert.equal(merged.content.answers[0].notes, 'Remote note');
  merged = mergeContent(row, local, { ...remote, reportText: 'Remote summary' });
  assert.equal(merged.complete, false); assert.equal(merged.conflicts[0].key, 'reportText');
  merged = mergeContent(row, local, { ...remote, reportText: 'Remote summary' }, { reportText: 'remote' });
  assert.equal(merged.complete, true); assert.equal(merged.content.reportText, 'Remote summary');
  assert.deepEqual(Object.keys(merged.content).sort(), ['answers', 'reportText']);
});

test('M3 confirmed merge replaces conflicting intents with a new ID and current server version', () => {
  const row = inspection(), store = new MemoryStore([row]); const remote = { ...row, version: 4, status: 'changes_requested' };
  store.save(row.id, complete(row)); store.save(row.id, complete(row), 'submit');
  const oldIds = store.queue.map((entry) => entry.mutationId);
  store.pause(store.queue[0], 'Conflict', remote); const copy = store.copies.get(row.id);
  assert.throws(() => store.resolve(row.id, remote, complete(row), 'submit', copy.generation - 1), /changed/);
  store.resolve(row.id, remote, complete(row, 'Merged'), 'submit', copy.generation);
  assert.equal(store.queue.length, 1); assert.equal(store.queue[0].body.baseVersion, 4);
  assert.ok(!oldIds.includes(store.queue[0].mutationId)); assert.equal(store.copies.get(row.id).conflict, null);
  assert.throws(() => store.resolve(row.id, { ...remote, status: 'cancelled' }, complete(row), 'save', store.copies.get(row.id).generation), /read-only/);
});

test('M3 no-op requests are skipped only before an attempt; verified server no-op is acknowledged safely', async () => {
  const row = inspection({ status: 'draft' }); row.answers = complete(row, '').answers;
  const store = new MemoryStore([row]);
  store.save(row.id, complete(row, 'Temporary')); store.save(row.id, complete(row, ''));
  let calls = 0;
  await flushOutbox({ store, request: async () => { calls++; return identity(); } });
  assert.equal(calls, 1); assert.equal(store.queue.length, 0);
  store.save(row.id, complete(row, 'Will match'));
  const attempt = store.prepare(store.queue[0]).request;
  const remote = { ...row, ...complete(row, 'Will match') };
  await flushOutbox({ store, request: async (path, options) => {
    if (path === '/auth/me') return identity();
    if (options.method) { assert.deepEqual(options.body, attempt.body); throw apiError(400, 'NO_CHANGES'); }
    return { inspection: remote };
  } });
  assert.equal(store.queue.length, 0); assert.equal(store.copies.get(row.id).base.version, 1);
});

test('M3 an unverified no-op never discards local intent', async () => {
  const row = inspection(), store = new MemoryStore([row]); store.save(row.id, complete(row));
  await flushOutbox({ store, request: async (path, options) => {
    if (path === '/auth/me') return identity();
    if (options.method) throw apiError(400, 'NO_CHANGES');
    return { inspection: { ...row, version: 2, status: 'draft', reportText: 'Different' } };
  } });
  assert.equal(store.queue[0].status, 'conflict'); assert.equal(store.copies.get(row.id).content.reportText, 'Checked locally');
});

test('M3 organization/user mismatch or a stopped workspace never dispatches a mutation', async () => {
  for (const session of [identity({ ...owner, userId: randomUUID() }), identity({ ...owner, organizationId: randomUUID() })]) {
    const row = inspection(), store = new MemoryStore([row]); store.save(row.id, complete(row)); let calls = 0;
    await flushOutbox({ store, request: async () => { calls++; return session; } });
    assert.equal(calls, 1); assert.equal(store.queue[0].status, 'pending');
  }
  const row = inspection(), store = new MemoryStore([row]); store.save(row.id, complete(row));
  let active = true, calls = 0; const prepare = store.prepare.bind(store);
  store.prepare = (entry) => { const result = prepare(entry); active = false; return result; };
  await flushOutbox({ store, active: () => active, request: async () => { calls++; return identity(); } });
  assert.equal(calls, 1); assert.equal(store.queue[0].status, 'attempted');
});

test('M3 expired sessions, revoked assignments and closed workflows preserve local work', async () => {
  for (const status of [401, 403, 404, 409]) {
    const row = inspection(), store = new MemoryStore([row]); store.save(row.id, complete(row)); let expired = false;
    await flushOutbox({ store, onExpired: () => { expired = true; }, request: async (path, options) => {
      if (path === '/auth/me') return identity();
      if (options.method) throw apiError(status, status === 409 ? 'INVALID_STATE' : 'ACCESS_DENIED');
    } });
    assert.equal(store.copies.get(row.id).content.reportText, 'Checked locally'); assert.equal(store.queue.length, 1);
    assert.equal(expired, status === 401); assert.equal(store.queue[0].status, status === 401 ? 'attempted' : 'blocked');
  }
  const row = inspection(), store = new MemoryStore([row]); store.save(row.id, complete(row)); let expired = false;
  await flushOutbox({ store, onExpired: () => { expired = true; }, request: async () => { throw apiError(401, 'UNAUTHENTICATED'); } });
  assert.equal(expired, true); assert.equal(store.queue[0].status, 'pending');
});

test('M3 invalid submission leaves the previously committed draft untouched', () => {
  const row = inspection(), store = new MemoryStore([row]);
  const draft = { reportText: 'Incomplete but retained', answers: [{ itemId: row.template.items[0].id, outcome: 'fail', notes: '' }] };
  store.save(row.id, draft); const before = structuredClone(store.queue);
  assert.throws(() => store.save(row.id, draft, 'submit'), /explain failed checks/);
  assert.deepEqual(store.queue, before); assert.deepEqual(store.copies.get(row.id).content, draft);
});

test('M3 a stale editor render becomes a conflict while an acknowledgment can advance the next local save', () => {
  const row = inspection(), expected = initialCopy(owner, row);
  const pulled = initialCopy(owner, { ...row, version: 2, status: 'draft', reportText: 'Remote edit' });
  const result = localChange(pulled, [], complete(row, 'Local buffer'), 'save', undefined, expected);
  assert.equal(result.copy.content.reportText, 'Local buffer');
  assert.equal(result.copy.conflict.base.version, 1); assert.equal(result.copy.conflict.remote.version, 2);
  assert.equal(result.queue[0].status, 'conflict');
  const acknowledged = { ...pulled, generation: 1, acknowledgedGeneration: 1 };
  const next = localChange(acknowledged, [], complete(row, 'Newer buffer'), 'save', undefined, expected);
  assert.equal(next.copy.conflict, null); assert.equal(next.queue[0].body.baseVersion, 2);
});
