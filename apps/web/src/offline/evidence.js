import { evidenceSchema,uploadResponseSchema,inspectionSchema,reserveEvidenceSchema } from '@fieldsync/contracts';

export async function uploadBlob(descriptor,blob,signal) {
  const upload=uploadResponseSchema.parse(descriptor);
  if (blob.size !== upload.size || (blob.type && blob.type !== upload.headers['Content-Type'])) {
    throw new Error('The local file does not match the upload reservation. It is retained for review.');
  }
  if (new Date(upload.expiresAt) <= new Date()) throw new Error('The upload URL expired. The local file is retained for retry.');
  if (upload.transport === 'server' && new URL(upload.url).origin !== globalThis.location?.origin) {
    throw new Error('Evidence uploads must use the current application origin.');
  }
  const timeout=AbortSignal.timeout(60000);
  // The browser supplies Content-Length from the Blob; scripts cannot set it.
  const response=await fetch(upload.url,{ method:upload.method,headers:upload.headers,body:blob,credentials:upload.transport==='server'?'same-origin':'omit',
    signal:signal?AbortSignal.any([signal,timeout]):timeout });
  if(!response.ok) throw new Error('File upload was interrupted or rejected. The local file is retained for retry.');
}
export async function replayEvidence({ store,request,attempt,upload=uploadBlob,active=()=>true }) {
  const path=`/inspections/${attempt.inspectionId}/evidence`;
  if(attempt.action==='remove') return request(`${path}/remove`,{ method:'POST',body:attempt.body,schema:inspectionSchema });
  // Try completion first: an earlier server commit may have lost its response,
  // and acknowledged evidence no longer needs a local Blob or staging upload.
  try { return await request(path,{ method:'POST',body:attempt.body,schema:inspectionSchema }); }
  catch(error) { if(!['EVIDENCE_NOT_FOUND','UPLOAD_MISSING','UPLOAD_EXPIRED'].includes(error.code)) throw error; }
  const { metadata,blob }=await store.file(attempt.body.evidenceId);
  if (metadata.id !== attempt.body.evidenceId || metadata.inspectionId !== attempt.inspectionId
    || metadata.organizationId !== store.owner.organizationId || metadata.userId !== store.owner.userId) {
    throw new Error('The local file belongs to another inspection or workspace. Local work is retained.');
  }
  const body=reserveEvidenceSchema.parse({ evidenceId:metadata.id,mutationId:metadata.reserveMutationId,
    name:metadata.name,mimeType:metadata.mimeType,size:metadata.size,sha256:metadata.sha256 });
  await request(`${path}/reserve`,{ method:'POST',body,schema:evidenceSchema });
  if(!active()) throw new Error('Workspace changed. The local file is retained.');
  const descriptor=await request(`${path}/${metadata.id}/upload`,{ method:'POST',body:{},schema:uploadResponseSchema });
  if(!active()) throw new Error('Workspace changed. The local file is retained.');
  await upload(descriptor,blob);
  if(!active()) throw new Error('Workspace changed. The local file is retained.');
  return request(path,{ method:'POST',body:attempt.body,schema:inspectionSchema });
}
