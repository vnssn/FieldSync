import { inspectionDetailSchema } from '@fieldsync/contracts';
import { HttpError } from '../../http/errors.js';
import { transaction } from '../../infrastructure/transaction.js';
import { mutate } from '../../infrastructure/mutations.js';
import { appendAudit, changesBetween, listAudit } from '../../infrastructure/audit.js';
import { assertAdmin } from '../auth/middleware.js';
import { enqueueJob } from '../jobs/repository.js';
import {
  findInspection, listInspections, findWorker, assignmentSnapshots, insertInspection,
  updateInspection, appendRevision, listRevisions,
} from './repository.js';

const editable = ['assigned', 'draft', 'changes_requested'];
const fields = ['answers', 'reportText', 'status', 'assignedTo', 'worker', 'reviewNote', 'submittedAt', 'approvedAt', 'approvedBy'];
function assertAccess(auth, inspection) {
  if (!inspection || (auth.user.role === 'worker' && inspection.assignedTo !== auth.user.id)) {
    throw new HttpError(404, 'INSPECTION_NOT_FOUND', 'Inspection not found.');
  }
}
function assertEditable(inspection) {
  if (!editable.includes(inspection.status)) throw new HttpError(409, 'INVALID_STATE', 'This inspection is not editable in its current state.');
}
function normalizeAnswers(inspection, input, submit) {
  const ids = new Set(inspection.template.items.map((item) => item.id));
  if (input.answers.some((answer) => !ids.has(answer.itemId))) throw new HttpError(400, 'INVALID_CHECKLIST', 'Answers must refer to this inspection checklist.');
  const answers = inspection.template.items.map((item) => input.answers.find((answer) => answer.itemId === item.id)
    ?? { itemId: item.id, outcome: null, notes: '' });
  if (submit && answers.some((answer) => !answer.outcome || (answer.outcome === 'fail' && !answer.notes))) {
    throw new HttpError(400, 'INCOMPLETE_CHECKLIST', 'Answer every checklist item and explain failed checks before submitting.');
  }
  return answers;
}
export function createInspectionsService(pool) {
  async function requireReadyEvidence(db, organizationId, id) {
    const result = await db.query(`SELECT processing_status FROM evidence
      WHERE organization_id=$1 AND inspection_id=$2 AND status='attached' AND processing_status <> 'ready'`, [organizationId, id]);
    if (result.rows.some((row) => row.processing_status === 'failed')) {
      throw new HttpError(409, 'EVIDENCE_NOT_READY', 'Remove or replace evidence that failed verification before submitting.');
    }
    if (result.rowCount) throw new HttpError(409, 'EVIDENCE_PROCESSING', 'Evidence verification is still running. Submission will retry automatically.');
  }
  async function authorize(db, auth, id) {
    if (!id) return null;
    const inspection = await findInspection(db, auth.organizationId, id, true);
    assertAccess(auth, inspection);
    return { inspection, inspectionReceiptId: id };
  }
  function change(auth, id, input, action, workerOnly, build) {
    if (workerOnly) {
      if (auth.user.role !== 'worker') throw new HttpError(403, 'FORBIDDEN', 'Only the assigned worker can edit inspection content.');
    } else assertAdmin(auth);
    return mutate(pool, auth, `inspections:${id}:${action}`, input, async (db, receipt) => {
      const resource = await authorize(db, auth, id);
      // A temporary prerequisite failure must not consume the mutation ID.
      // Already committed requests still replay after workflow state advances.
      if (!receipt && resource.inspection.version === input.baseVersion
        && ((action === 'submitted' && editable.includes(resource.inspection.status))
          || (action === 'approved' && resource.inspection.status === 'submitted'))) {
        await requireReadyEvidence(db, auth.organizationId, id);
      }
      return resource;
    }, async (db, { inspection: previous }) => {
      if (previous.version !== input.baseVersion) throw new HttpError(409, 'VERSION_CONFLICT', 'This inspection changed. Reload and review before saving.');
      if (['approved', 'cancelled'].includes(previous.status)) throw new HttpError(409, 'INVALID_STATE', 'This inspection is closed and cannot be changed.');
      const next = await build(db, previous);
      const changes = changesBetween(previous, next, fields);
      if (!Object.keys(changes).length) throw new HttpError(400, 'NO_CHANGES', 'No inspection fields have changed.');
      const inspection = await updateInspection(db, auth.organizationId, id, input.baseVersion, next);
      if (!inspection) throw new HttpError(409, 'VERSION_CONFLICT', 'This inspection changed. Reload before saving.');
      await appendRevision(db, auth, inspection);
      await appendAudit(db, 'inspection', auth, inspection, action, changes, input.note ?? '');
      if (action === 'submitted') await enqueueJob(db,auth.organizationId,id,'prepare_report',`report:${id}:${inspection.version}`,{ payload:{ sourceVersion:inspection.version } });
      return { body: inspection, inspectionId: id };
    });
  }
  function save(auth, id, input, submit) {
    return change(auth, id, input, submit ? 'submitted' : 'saved', true, async (db, previous) => {
      assertEditable(previous);
      return { ...previous, answers: normalizeAnswers(previous, input, submit), reportText: input.reportText,
        status: submit ? 'submitted' : 'draft',
        submittedAt: submit ? new Date().toISOString() : previous.submittedAt,
        reviewNote: submit ? '' : previous.reviewNote };
    });
  }
  return {
    list(auth, query) { return listInspections(pool, auth, query.status); },
    detail(auth, id) {
      return transaction(pool, async (db) => {
        const inspection = await findInspection(db, auth.organizationId, id);
        assertAccess(auth, inspection);
        return inspectionDetailSchema.parse({ inspection,
          events: await listAudit(db, 'inspection', auth.organizationId, id), revisions: await listRevisions(db, auth.organizationId, id) });
      }, { readOnly: true });
    },
    create(auth, input) {
      assertAdmin(auth);
      return mutate(pool, auth, 'inspections:create', input, (db, receipt) => authorize(db, auth, receipt?.inspection_id), async (db) => {
        const inspection = await insertInspection(db, auth, input, await assignmentSnapshots(db, auth, input));
        await appendRevision(db, auth, inspection);
        await appendAudit(db, 'inspection', auth, inspection, 'created', changesBetween(null, inspection, ['asset', 'template', ...fields]));
        return { body: inspection, inspectionId: inspection.id };
      });
    },
    save(auth, id, input) { return save(auth, id, input, false); },
    submit(auth, id, input) { return save(auth, id, input, true); },
    reassign(auth, id, input) {
      return change(auth, id, input, 'reassigned', false, async (db, previous) => {
        assertEditable(previous);
        return { ...previous, assignedTo: input.assignedTo, worker: await findWorker(db, auth.organizationId, input.assignedTo), status: 'assigned' };
      });
    },
    cancel(auth, id, input) {
      return change(auth, id, input, 'cancelled', false, async (_db, previous) => ({ ...previous, status: 'cancelled', reviewNote: input.note }));
    },
    review(auth, id, input) {
      return change(auth, id, input, input.decision === 'approve' ? 'approved' : 'changes_requested', false, async (_db, previous) => {
        if (previous.status !== 'submitted') throw new HttpError(409, 'INVALID_STATE', 'Only submitted reports can be reviewed.');
        return { ...previous, status: input.decision === 'approve' ? 'approved' : 'changes_requested', reviewNote: input.note,
          approvedBy: input.decision === 'approve' ? auth.user.id : null,
          approvedAt: input.decision === 'approve' ? new Date().toISOString() : null };
      });
    },
  };
}
