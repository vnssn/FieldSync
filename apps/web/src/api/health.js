import { HealthResponseSchema } from '@fieldsync/contracts';

export async function fetchHealth({ signal }) {
  const response = await fetch('/api/v1/health', {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.any([signal, AbortSignal.timeout(7000)]),
  });

  if (response.status !== 200 && response.status !== 503) {
    throw new Error('The API could not return its health status. Check that the server is running.');
  }

  const result = HealthResponseSchema.safeParse(await response.json());
  if (!result.success || (response.status === 200) !== (result.data.status === 'ok')) {
    throw new Error('The API returned an unexpected health response.');
  }
  return result.data;
}
