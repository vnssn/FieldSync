import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { EnvironmentSchema } from './schema.js';

export const projectRoot = fileURLToPath(new URL('../../../../', import.meta.url));

dotenv.config({
  path: fileURLToPath(new URL('../../../../.env', import.meta.url)),
  quiet: true,
});

const result = EnvironmentSchema.safeParse(process.env);

if (!result.success) {
  const fields = result.error.issues.map((issue) => issue.path.join('.') + ': ' + issue.message);
  throw new Error('Invalid FieldSync configuration. Check the root .env file.\n' + fields.join('\n'));
}

export const env = Object.freeze(result.data);
