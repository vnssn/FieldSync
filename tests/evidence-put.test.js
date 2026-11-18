import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { uploadResponseSchema } from '@fieldsync/contracts';
import { createEvidenceStorage, evidencePrefix } from '../apps/server/src/infrastructure/storage.js';
import { uploadBlob } from '../apps/web/src/offline/evidence.js';

// Signing-only synthetic configuration: no R2 account or network is used here.
const settings = {
  S3_ENDPOINT: 'https://internal.example.test', S3_PUBLIC_ENDPOINT: 'https://test-account.r2.cloudflarestorage.com',
  S3_REGION: 'auto', S3_BUCKET: 'test-evidence', S3_FORCE_PATH_STYLE: true,
  S3_ACCESS_KEY_ID: 'test-access', S3_SECRET_ACCESS_KEY: 'synthetic-test-signing-secret',
};
const bytes = Buffer.from('local upload transport fixture');
const sha256 = createHash('sha256').update(bytes).digest('hex');
function row(expiresAt = new Date(Date.now() + 20 * 60000)) {
  const organization_id = randomUUID(), inspection_id = randomUUID(), id = randomUUID();
  return { organization_id, inspection_id, id, staging_key: `${evidencePrefix(organization_id, inspection_id, id)}/staging/${randomUUID()}`,
    mime_type: 'image/png', size: bytes.length, sha256, expires_at: expiresAt };
}
function descriptor(url = 'https://storage.example.test/upload') {
  return { url, method: 'PUT', headers: { 'Content-Type': 'image/png', 'x-amz-meta-sha256': sha256 },
    size: bytes.length, expiresAt: new Date(Date.now() + 60000).toISOString() };
}

test('R2 PUT signing binds the public host, exact key, type, length and SHA metadata without optional AWS checksums', async () => {
  const storage = createEvidenceStorage(settings), file = row();
  try {
    const upload = await storage.presign(file), url = new URL(upload.url);
    assert.equal(url.origin, settings.S3_PUBLIC_ENDPOINT);
    assert.equal(decodeURIComponent(url.pathname), `/${settings.S3_BUCKET}/${file.staging_key}`);
    assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'content-length;content-type;host;x-amz-meta-sha256');
    assert.equal(url.searchParams.get('X-Amz-Expires'), '600');
    assert.match(url.searchParams.get('X-Amz-Credential'), /\/auto\/s3\/aws4_request$/);
    assert.equal(url.searchParams.get('X-Amz-Content-Sha256'), 'UNSIGNED-PAYLOAD');
    assert.ok(![...url.searchParams.keys()].some((key) => /checksum|sdk-checksum|x-amz-meta-sha256/i.test(key)));
    assert.equal(upload.size, file.size);
    assert.deepEqual(upload.headers, descriptor().headers);
    assert.ok(!JSON.stringify(upload).includes(settings.S3_SECRET_ACCESS_KEY));
    assert.ok(new Date(upload.expiresAt) <= file.expires_at);
  } finally { storage.client.destroy(); }
});

test('PUT URLs expire within their reservation and cannot sign expired or foreign storage keys', async () => {
  const storage = createEvidenceStorage(settings);
  try {
    const file = row(new Date(Date.now() + 45000));
    const upload = await storage.presign(file);
    assert.ok(Number(new URL(upload.url).searchParams.get('X-Amz-Expires')) <= 45);
    assert.ok(new Date(upload.expiresAt) <= file.expires_at);
    await assert.rejects(storage.presign(row(new Date(Date.now() - 1000))), (error) => error.code === 'UPLOAD_EXPIRED');
    await assert.rejects(storage.presign({ ...file, staging_key: row().staging_key }), (error) => error.code === 'INVALID_STORAGE_KEY');
  } finally { storage.client.destroy(); }
});

test('PUT descriptors reject form POSTs, injected headers, invalid hashes/protocols and oversized photos', () => {
  assert.equal(uploadResponseSchema.safeParse(descriptor()).success, true);
  for (const change of [
    { method: 'POST' }, { fields: { policy: 'old transport' } }, { url: 'ftp://storage.example.test/file' },
    { size: 10 * 1024 * 1024 + 1 }, { headers: { ...descriptor().headers, Authorization: 'injected' } },
    { headers: { ...descriptor().headers, 'x-amz-meta-sha256': 'bad' } },
  ]) assert.equal(uploadResponseSchema.safeParse({ ...descriptor(), ...change }).success, false);
});

test('browser upload sends raw bytes and exact headers, omits cookies, and accepts storage 2xx responses', async () => {
  let received;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received = { method: req.method, headers: req.headers, bytes: Buffer.concat(chunks) };
    res.writeHead(200); res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    await uploadBlob(descriptor(`http://127.0.0.1:${server.address().port}/upload`), new Blob([bytes], { type: 'image/png' }));
    assert.equal(received.method, 'PUT');
    assert.equal(received.headers['content-type'], 'image/png');
    assert.equal(received.headers['content-length'], String(bytes.length));
    assert.equal(received.headers['x-amz-meta-sha256'], sha256);
    assert.equal(received.headers.cookie, undefined);
    assert.deepEqual(received.bytes, bytes);
  } finally { await new Promise((done) => server.close(done)); }
});

test('browser retains mismatched or expired files and rejects transport errors without changing the Blob', async (t) => {
  const blob = new Blob([bytes], { type: 'image/png' });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (...args) => { calls.push(args); return { ok: false, status: 403 }; });
  await assert.rejects(uploadBlob({ ...descriptor(), size: bytes.length + 1 }, blob), /retained/);
  await assert.rejects(uploadBlob(descriptor(), new Blob([bytes], { type: 'image/jpeg' })), /retained/);
  await assert.rejects(uploadBlob({ ...descriptor(), expiresAt: new Date(0).toISOString() }, blob), /expired/);
  assert.equal(calls.length, 0);
  await assert.rejects(uploadBlob(descriptor(), blob), /retained for retry/);
  assert.equal(calls[0][1].credentials, 'omit');
  assert.equal(calls[0][1].body, blob);
  assert.equal(calls[0][1].headers['Content-Length'], undefined);
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), bytes);
});
