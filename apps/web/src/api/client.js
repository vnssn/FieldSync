import { ErrorResponseSchema } from '@fieldsync/contracts';

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function apiRequest(path, { method = 'GET', body, schema, signal } = {}) {
  const response = await fetch(`/api/v1${path}`, {
    method, credentials: 'same-origin', cache: 'no-store',
    headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
  });
  if (response.status === 204 && response.ok) return null;
  const data = await response.json();
  if (!response.ok) {
    const parsed = ErrorResponseSchema.safeParse(data);
    throw new ApiError(parsed.success ? parsed.data.error.message : 'The request failed. Please try again.',
      response.status, parsed.success ? parsed.data.error.code : 'REQUEST_FAILED');
  }
  return schema.parse(data);
}
