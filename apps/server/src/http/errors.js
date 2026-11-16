export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function parseRequest(schema, value) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || 'request'))];
    throw new HttpError(400, 'INVALID_REQUEST', `Check these fields: ${fields.join(', ')}.`);
  }
  return parsed.data;
}
