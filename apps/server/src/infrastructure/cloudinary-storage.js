import { v2 as cloudinary } from 'cloudinary';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { uploadResponseSchema } from '@fieldsync/contracts';
import { assertEvidenceKey, evidencePrefix, readEvidenceBytes, validateEvidenceBytes } from './storage.js';
import { HttpError } from '../http/errors.js';
import { applicationOrigins } from '../http/security.js';

const keySchema = z.string().regex(/^org\/[a-f0-9-]{36}\/inspections\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/(staging|verified)\/[a-f0-9-]{36}$/);
function assertKey(key) {
  if (!keySchema.safeParse(key).success || !z.array(z.uuid()).safeParse([key.split('/')[1],key.split('/')[3],key.split('/')[4],key.split('/')[6]]).success) {
    throw new HttpError(400,'INVALID_STORAGE_KEY','Evidence storage ownership does not match.');
  }
}

export function createCloudinaryStorage(env, sdk = cloudinary, fetchFile = fetch) {
  // Per-call credentials avoid the SDK's process-global configuration and
  // cannot leak between deployment namespaces or injected test adapters.
  const options = { cloud_name: env.CLOUDINARY_CLOUD_NAME, api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET, secure: true, resource_type: 'raw', type: 'authenticated', timeout: 15000 };
  const namespace = `${env.CLOUDINARY_FOLDER}/`;
  const publicId = (key) => { assertKey(key); return namespace + key; };
  async function write(key,bytes,row) {
    const id = publicId(key);
    const result = await new Promise((resolve,reject) => {
      const stream = sdk.uploader.upload_stream({ ...options,public_id:id,overwrite:false,unique_filename:false,
        use_filename:false },(error,result) => error ? reject(error) : resolve(result));
      stream.on('error',reject); stream.end(bytes);
    });
    if (result.public_id !== id || result.resource_type !== 'raw' || result.type !== 'authenticated' || result.bytes !== row.size) {
      throw new HttpError(502,'STORAGE_INVALID_RESPONSE','Evidence storage returned an unexpected result.');
    }
  }
  return {
    client: { destroy() {} },
    async verify() {
      await sdk.api.resources({ ...options,prefix:`${namespace}org/`,max_results:1 });
    },
    async presign(row,{ origin = env.APP_ORIGIN } = {}) {
      if (!applicationOrigins(env).has(origin)) throw new HttpError(403,'INVALID_ORIGIN','This request must come from an allowed application origin.');
      assertEvidenceKey(row,row.staging_key,'staging');
      const expiresAt = new Date(Math.min(Date.now()+600000,row.expires_at.getTime()));
      if (expiresAt <= new Date()) throw new HttpError(410,'UPLOAD_EXPIRED','This staging upload expired. Request a new upload.');
      return uploadResponseSchema.parse({ transport:'server',url:`${origin}/api/v1/inspections/${row.inspection_id}/evidence/${row.id}/content/${row.staging_key.split('/').at(-1)}`,
        method:'PUT',headers:{ 'Content-Type':row.mime_type,'x-amz-meta-sha256':row.sha256 },size:row.size,expiresAt:expiresAt.toISOString() });
    },
    async upload(row,bytes) {
      assertEvidenceKey(row,row.staging_key,'staging'); validateEvidenceBytes(bytes,row);
      if (row.expires_at <= new Date()) throw new HttpError(410,'UPLOAD_EXPIRED','This staging upload expired. Request a new upload.');
      await write(row.staging_key,bytes,row);
      // overwrite:false makes retries immutable too. Read back the stored
      // object, including when Cloudinary returns an already-existing asset.
      await this.read(row.staging_key,row);
    },
    async read(key,row) {
      assertEvidenceKey(row,key,key === row.staging_key ? 'staging' : 'verified');
      const url = sdk.utils.private_download_url(publicId(key),undefined,{ ...options,expires_at:Math.floor(Date.now()/1000)+60,attachment:true });
      // This signed URL never reaches a browser, response body or logger.
      const response = await fetchFile(url,{ signal:AbortSignal.timeout(15000),redirect:'error' });
      if (response.status === 404) throw new HttpError(409,'UPLOAD_MISSING','Upload the file before attaching it.');
      if (!response.ok) throw new HttpError(502,'STORAGE_UNAVAILABLE','Evidence storage is unavailable.');
      try {
        const length = response.headers.get('content-length');
        if (length !== null && length !== String(row.size)) throw new HttpError(400,'INVALID_FILE','Uploaded size does not match the reservation.');
        return await readEvidenceBytes(response.body,row,15000);
      } finally { await response.body?.cancel().catch(() => {}); }
    },
    async promote(row) {
      const bytes = await this.read(row.staging_key,row);
      const key = `${evidencePrefix(row.organization_id,row.inspection_id,row.id)}/verified/${randomUUID()}`;
      await write(key,bytes,row);
      await this.read(key,row);
      return key;
    },
    async remove(key) {
      if (!key) return;
      const result = await sdk.uploader.destroy(publicId(key),{ ...options,invalidate:true });
      if (!['ok','not found'].includes(result.result)) throw new HttpError(502,'STORAGE_UNAVAILABLE','Evidence deletion could not be confirmed.');
    },
    async *objects(prefix = 'org/') {
      if (typeof prefix !== 'string' || !prefix.startsWith('org/') || prefix.includes('..')) throw new HttpError(400,'INVALID_STORAGE_KEY','Invalid evidence prefix.');
      let cursor;
      do {
        const result = await sdk.api.resources({ ...options,prefix:namespace+prefix,max_results:100,next_cursor:cursor });
        for (const asset of result.resources ?? []) {
          if (asset.type !== 'authenticated' || asset.resource_type !== 'raw' || !asset.public_id?.startsWith(namespace+prefix)) continue;
          const key = asset.public_id.slice(namespace.length);
          if (!keySchema.safeParse(key).success) continue;
          yield { Key:key,LastModified:new Date(asset.created_at) };
        }
        cursor = result.next_cursor;
      } while (cursor);
    },
  };
}
