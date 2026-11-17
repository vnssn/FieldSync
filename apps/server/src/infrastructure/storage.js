import { S3Client, HeadBucketCommand, CreateBucketCommand, HeadObjectCommand, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { uploadResponseSchema, EVIDENCE_LIMITS } from '@fieldsync/contracts';
import { HttpError } from '../http/errors.js';

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

export function createEvidenceStorage(env, client = createStorageClient(env)) {
  const send = (command) => client.send(command, { abortSignal: AbortSignal.timeout(15000) });
  const Bucket = env.S3_BUCKET;
  return {
    client,
    // S3 SigV4 POST policy constrains the exact staging key, type and file length.
    // No signing helper dependency is needed; signing secrets stay on the server.
    presign(row) {
      assertEvidenceKey(row, row.staging_key, 'staging');
      const now = new Date(), expires = new Date(Math.min(now.getTime() + 10 * 60000, row.expires_at.getTime()));
      if (expires <= now) throw new HttpError(410, 'UPLOAD_EXPIRED', 'This staging upload expired. Queue the file again with a new ID.');
      const date = now.toISOString().replace(/[:-]|\.\d{3}/g, ''), day = date.slice(0,8);
      const scope = `${day}/${env.S3_REGION}/s3/aws4_request`;
      const fields = { key: row.staging_key, 'Content-Type': row.mime_type, 'x-amz-meta-sha256': row.sha256,
        'x-amz-algorithm': 'AWS4-HMAC-SHA256', 'x-amz-credential': `${env.S3_ACCESS_KEY_ID}/${scope}`, 'x-amz-date': date,
        success_action_status: '204' };
      const policy = Buffer.from(JSON.stringify({ expiration: expires.toISOString(),
        conditions: [{ bucket: Bucket }, ...Object.entries(fields).map(([key,value]) => ({ [key]: value })), ['content-length-range', row.size, row.size]] })).toString('base64');
      const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
      const signingKey = hmac(hmac(hmac(hmac(`AWS4${env.S3_SECRET_ACCESS_KEY}`, day), env.S3_REGION), 's3'), 'aws4_request');
      return uploadResponseSchema.parse({ url: `${env.S3_PUBLIC_ENDPOINT.replace(/\/$/, '')}/${encodeURIComponent(Bucket)}`,
        fields: { ...fields, policy, 'x-amz-signature': createHmac('sha256', signingKey).update(policy).digest('hex') }, expiresAt: expires.toISOString() });
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
