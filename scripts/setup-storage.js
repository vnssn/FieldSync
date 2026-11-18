import { pathToFileURL } from 'node:url';
import { env } from '../apps/server/src/config/env.js';
import { createStorageClient, createEvidenceStorage, ensureBucket } from '../apps/server/src/infrastructure/storage.js';

export async function setupStorage() {
  if (env.EVIDENCE_STORAGE_PROVIDER === 'cloudinary') {
    const storage = createEvidenceStorage(env);
    try { await storage.verify(); console.log('Authenticated Cloudinary evidence storage is reachable.'); }
    finally { storage.client.destroy(); }
    return;
  }
  const client = createStorageClient(env);
  try {
    const outcome = await ensureBucket(client, env.S3_BUCKET, env.S3_REGION);
    console.log('Private S3 bucket ' + env.S3_BUCKET + ': ' + outcome);
  } finally {
    client.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  setupStorage().catch((error) => {
    console.error('Storage setup failed (' + error.name + '). Check MinIO readiness and local credentials.');
    process.exitCode = 1;
  });
}
