import { S3Client, HeadBucketCommand, CreateBucketCommand } from '@aws-sdk/client-s3';

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
