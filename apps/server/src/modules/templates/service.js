import { randomUUID } from 'node:crypto';
import { templateDetailSchema } from '@fieldsync/contracts';
import { HttpError } from '../../http/errors.js';
import { transaction } from '../../infrastructure/transaction.js';
import { mutate } from '../../infrastructure/mutations.js';
import { appendAudit, changesBetween, listAudit } from '../../infrastructure/audit.js';
import { assertAdmin } from '../auth/middleware.js';
import { findTemplate, listTemplates, insertTemplate, updateTemplate } from './repository.js';

const fields = ['name', 'description', 'items', 'status'];
export function createTemplatesService(pool) {
  async function authorize(db, auth, id) {
    assertAdmin(auth);
    if (!id) return null;
    const template = await findTemplate(db, auth.organizationId, id, true);
    if (!template) throw new HttpError(404, 'TEMPLATE_NOT_FOUND', 'Template not found.');
    return { template, templateReceiptId: id };
  }
  return {
    list(auth, query) { assertAdmin(auth); return listTemplates(pool, auth.organizationId, query.status); },
    detail(auth, id) {
      assertAdmin(auth);
      return transaction(pool, async (db) => {
        const template = await findTemplate(db, auth.organizationId, id);
        if (!template) throw new HttpError(404, 'TEMPLATE_NOT_FOUND', 'Template not found.');
        return templateDetailSchema.parse({ template, events: await listAudit(db, 'template', auth.organizationId, id) });
      }, { readOnly: true });
    },
    create(auth, input) {
      assertAdmin(auth);
      return mutate(pool, auth, 'templates:create', input,
        (db, receipt) => authorize(db, auth, receipt?.template_id), async (db) => {
          const template = await insertTemplate(db, auth, randomUUID(), input);
          await appendAudit(db, 'template', auth, template, 'created', changesBetween(null, template, fields));
          return { body: template, templateId: template.id };
        });
    },
    update(auth, id, input) {
      assertAdmin(auth);
      return mutate(pool, auth, `templates:${id}:update`, input, (db) => authorize(db, auth, id), async (db, { template: previous }) => {
        if (previous.version !== input.baseVersion) throw new HttpError(409, 'VERSION_CONFLICT', 'This template changed. Reload before saving.');
        const changes = changesBetween(previous, input, fields);
        if (!Object.keys(changes).length) throw new HttpError(400, 'NO_CHANGES', 'No template fields have changed.');
        const template = await updateTemplate(db, auth.organizationId, id, input);
        if (!template) throw new HttpError(409, 'VERSION_CONFLICT', 'This template changed. Reload before saving.');
        await appendAudit(db, 'template', auth, template, 'updated', changes);
        return { body: template, templateId: id };
      });
    },
  };
}
