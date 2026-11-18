import { S3Client, HeadBucketCommand, CreateBucketCommand, HeadObjectCommand, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { uploadResponseSchema, EVIDENCE_LIMITS } from '@fieldsync/contracts';
import { HttpError } from '../http/errors.js';
import { createCloudinaryStorage } from './cloudinary-storage.js';

export function createStorageClient(env) {
  return new S3Client({
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
    maxAttempts: 2,
    // R2 does not support all AWS automatic checksum/trailer combinations.
    // Evidence integrity is checked independently against the reserved SHA-256.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

export async function verifyBucket(client, bucket) {
  await client.send(new HeadBucketCommand({ Bucket: bucket }), {
    abortSignal: AbortSignal.timeout(6000),
  });
}

export async function ensureBucket(client, bucket, region) {
  try {
    await verifyBucket(client, bucket);
    return 'already exists';
  } catch (error) {
    if (error.$metadata?.httpStatusCode !== 404) throw error;
  }

  try {
    await client.send(new CreateBucketCommand({
      Bucket: bucket,
      ...(region === 'us-east-1' ? {} : { CreateBucketConfiguration: { LocationConstraint: region } }),
    }), { abortSignal: AbortSignal.timeout(6000) });
  } catch (error) {
    if (error.name !== 'BucketAlreadyOwnedByYou') throw error;
  }

  await verifyBucket(client, bucket);
  return 'created';
}

export function evidencePrefix(organizationId, inspectionId, evidenceId) {
  return `org/${organizationId}/inspections/${inspectionId}/${evidenceId}`;
}
export function assertEvidenceKey(row, key, kind) {
  const prefix = `${evidencePrefix(row.organization_id, row.inspection_id, row.id)}/${kind}/`;
  if (typeof key !== 'string' || !key.startsWith(prefix) || !z.uuid().safeParse(key.slice(prefix.length)).success) {
    throw new HttpError(400, 'INVALID_STORAGE_KEY', 'Evidence storage ownership does not match.');
  }
}
export function matchesSignature(bytes, mime) {
  const ascii = (start, end) => bytes.subarray(start, end).toString('ascii');
  switch (mime) {
    case 'image/jpeg': return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    case 'image/png': return bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    case 'image/webp': return ascii(0,4) === 'RIFF' && ascii(8,12) === 'WEBP';
    case 'audio/wav': return ascii(0,4) === 'RIFF' && ascii(8,12) === 'WAVE';
    case 'audio/ogg': return ascii(0,4) === 'OggS';
    case 'audio/webm': return bytes.subarray(0,4).equals(Buffer.from([26,69,223,163]));
    case 'audio/mpeg': return ascii(0,3) === 'ID3' || (bytes.length >= 2 && bytes[0] === 255 && (bytes[1] & 224) === 224);
    default: return false;
  }
}

export function validateEvidenceBytes(bytes, expected) {
  const limit = EVIDENCE_LIMITS[expected.mime_type.startsWith('image/') ? 'photo' : 'audio'];
  if (bytes.length !== expected.size || bytes.length > limit || !matchesSignature(bytes,expected.mime_type)
    || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) {
    throw new HttpError(400,'INVALID_FILE','File size, signature or checksum verification failed.');
  }
  return bytes;
}

export async function readEvidenceBytes(stream, expected, timeoutMs = 60000) {
  const limit = EVIDENCE_LIMITS[expected.mime_type.startsWith('image/') ? 'photo' : 'audio'];
  const iterator = stream.iterator?.({ destroyOnReturn:false }) ?? stream[Symbol.asyncIterator](), chunks = [];
  let length = 0, timer;
  const timeout = new Promise((_,reject) => { timer = setTimeout(() => reject(new HttpError(408,'UPLOAD_TIMEOUT','File transfer timed out. Retry the upload.')),timeoutMs); });
  try {
    while (true) {
      const { value,done } = await Promise.race([iterator.next(),timeout]);
      if (done) break;
      const chunk = Buffer.from(value); length += chunk.length;
      if (length > expected.size || length > limit) throw new HttpError(400,'INVALID_FILE','Uploaded file exceeds its size limit.');
      chunks.push(chunk);
    }
    return validateEvidenceBytes(Buffer.concat(chunks,length),expected);
  } finally {
    clearTimeout(timer);
    // Release/cancel fetch readers and stop iterators after invalid transfers.
    // Do not wait on a stalled peer after the transfer deadline.
    iterator.return?.().catch(() => {});
  }
}

export function createEvidenceStorage(env, client) {
  if (env.EVIDENCE_STORAGE_PROVIDER === 'cloudinary') return createCloudinaryStorage(env,client);
  client ??= createStorageClient(env);
  const send = (command) => client.send(command, { abortSignal: AbortSignal.timeout(15000) });
  const Bucket = env.S3_BUCKET;
  // Sign the browser endpoint directly: changing a signed URL's host invalidates it.
  const uploadClient = createStorageClient({ ...env, S3_ENDPOINT: env.S3_PUBLIC_ENDPOINT });
  const destroy = client.destroy.bind(client);
  client.destroy = () => { uploadClient.destroy(); destroy(); };
  return {
    client,
    async verify() { await verifyBucket(client,Bucket); },
    async presign(row) {
      assertEvidenceKey(row, row.staging_key, 'staging');
      const now = new Date(Math.floor(Date.now() / 1000) * 1000);
      const expiresIn = Math.min(600, Math.floor((row.expires_at.getTime() - now.getTime()) / 1000));
      if (expiresIn < 1) throw new HttpError(410, 'UPLOAD_EXPIRED', 'This staging upload expired. Queue the file again with a new ID.');
      const headers = { 'Content-Type': row.mime_type, 'x-amz-meta-sha256': row.sha256 };
      const url = await getSignedUrl(uploadClient, new PutObjectCommand({
        Bucket, Key: row.staging_key, ContentType: row.mime_type,
        ContentLength: row.size, Metadata: { sha256: row.sha256 },
      }), {
        expiresIn, signingDate: now,
        // The SDK normally omits content-type and hoists x-amz-* into the query.
        signableHeaders: new Set(['content-type', 'content-length', 'x-amz-meta-sha256']),
        unhoistableHeaders: new Set(['x-amz-meta-sha256']),
      });
      return uploadResponseSchema.parse({ url, method: 'PUT', headers, size: row.size,
        expiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString() });
    },
    async read(key, expected) {
      const kind = key === expected.staging_key ? 'staging' : 'verified';
      assertEvidenceKey(expected, key, kind);
      let head;
      try { head = await send(new HeadObjectCommand({ Bucket, Key: key })); }
      catch (error) { if (error.$metadata?.httpStatusCode === 404) throw new HttpError(409, 'UPLOAD_MISSING', 'Upload the file before attaching it.'); throw error; }
      const limit = EVIDENCE_LIMITS[expected.mime_type.startsWith('image/') ? 'photo' : 'audio'];
      if (head.ContentLength !== expected.size || head.ContentLength > limit || head.ContentType !== expected.mime_type) {
        throw new HttpError(400, 'INVALID_FILE', 'Uploaded size or MIME type does not match the file.');
      }
      const response = await send(new GetObjectCommand({ Bucket, Key: key }));
      const chunks = []; let length = 0;
      try {
        for await (const chunk of response.Body) {
          length += chunk.length;
          if (length > expected.size || length > limit) throw new HttpError(400, 'INVALID_FILE', 'Uploaded file exceeds its size limit.');
          chunks.push(chunk);
        }
      } finally { response.Body.destroy?.(); }
      const bytes = Buffer.concat(chunks);
      if (length !== expected.size || !matchesSignature(bytes, expected.mime_type)
        || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) {
        throw new HttpError(400, 'INVALID_FILE', 'File signature or checksum verification failed.');
      }
      return bytes;
    },
    async promote(row) {
      // Write the verified buffer, never copy bytes from mutable staging after checking it.
      const bytes = await this.read(row.staging_key, row);
      const key = `${evidencePrefix(row.organization_id, row.inspection_id, row.id)}/verified/${randomUUID()}`;
      await send(new PutObjectCommand({ Bucket, Key: key, Body: bytes, ContentType: row.mime_type,
        Metadata: { sha256: row.sha256 }, IfNoneMatch: '*' }));
      return key;
    },
    async remove(key) { if (key) await send(new DeleteObjectCommand({ Bucket, Key: key })); },
    async *objects(prefix = 'org/') {
      let token;
      do {
        const result = await send(new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken: token }));
        yield* result.Contents ?? []; token = result.IsTruncated ? result.NextContinuationToken : null;
      } while (token);
    },
  };
}
