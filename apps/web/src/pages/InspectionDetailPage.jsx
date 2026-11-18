import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  inspectionDetailSchema, inspectionSchema, reviewInspectionSchema,
  reassignInspectionSchema, cancelInspectionSchema, usersResponseSchema,
} from '@fieldsync/contracts';
import { useAuth } from '../auth.jsx';
import { apiRequest } from '../api/client.js';
import { ErrorNotice, PageIntro, QueryState } from '../components/ui.jsx';
import { useOnlineMutation, MutationNotice, InspectionReport, AuditHistory } from '../components/inspection-ui.jsx';
import { WorkerInspectionDetail } from './WorkerInspections.jsx';
import { EvidencePanel } from '../components/evidence-ui.jsx';
import { AiPanel } from '../components/ai-ui.jsx';

function AdminActions({ inspection, organizationId, onReload }) {
  const [note, setNote] = useState('');
  const [workerId, setWorkerId] = useState(inspection.assignedTo);
  const [error, setError] = useState(null);
  const mutation = useOnlineMutation(inspectionSchema);
  const editable = ['assigned', 'draft', 'changes_requested'].includes(inspection.status);
  const closed = ['approved', 'cancelled'].includes(inspection.status);
  const users = useQuery({ queryKey: ['users', organizationId], enabled: editable,
    queryFn: ({ signal }) => apiRequest('/users', { schema: usersResponseSchema, signal }) });
  function send(schema, suffix, method, extra) {
    const parsed = schema.safeParse({ ...extra, baseVersion: inspection.version, mutationId: crypto.randomUUID() });
    if (!parsed.success) { setError(new Error(parsed.error.issues[0].message)); return; }
    setError(null); mutation.send(`/inspections/${inspection.id}/${suffix}`, method, parsed.data);
  }
  if (closed) return null;
  return <section className="panel print-hidden mb-6 space-y-4"><h2 className="text-xl font-semibold">{inspection.status === 'submitted' ? 'Review submitted report' : 'Manage assignment'}</h2>
    <ErrorNotice error={error ?? users.error} /><MutationNotice mutation={mutation} onReload={onReload} />
    <fieldset disabled={mutation.blocked} className="space-y-4">
      <label className="block text-sm font-medium">Review / cancellation note<textarea aria-label="Review / cancellation note" className="input mt-2" value={note} rows={3} maxLength={2000} onChange={(event) => setNote(event.target.value)} /></label>
      {inspection.status === 'submitted' && <div className="flex flex-wrap gap-3">
        <button className="button-primary" onClick={() => send(reviewInspectionSchema, 'review', 'POST', { decision: 'approve', note })}>Approve report</button>
        <button className="button-secondary" onClick={() => send(reviewInspectionSchema, 'review', 'POST', { decision: 'request_changes', note })}>Request changes</button>
      </div>}
      {editable && <div className="flex flex-wrap items-end gap-3"><label className="min-w-48 flex-1 text-sm font-medium">Assigned worker<select aria-label="Assigned worker" className="input mt-2" value={workerId} onChange={(event) => setWorkerId(event.target.value)}>
        {users.data?.users.filter((user) => user.role === 'worker').map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label>
        <button className="button-secondary" disabled={workerId === inspection.assignedTo || users.isPending || users.isError}
          onClick={() => send(reassignInspectionSchema, 'assignment', 'PATCH', { assignedTo: workerId })}>Reassign</button></div>}
      <button className="text-sm text-red-800 underline" onClick={() => {
        if (window.confirm('Cancel this inspection? It will become read-only.')) send(cancelInspectionSchema, 'cancel', 'POST', { note });
      }}>Cancel inspection</button>
    </fieldset></section>;
}
function OnlineInspectionDetailPage() {
  const { id } = useParams();
  const { session } = useAuth();
  const organizationId = session.data.organization.id;
  const [revision, setRevision] = useState('');
  const query = useQuery({ queryKey: ['inspection', organizationId, id], refetchOnWindowFocus: false,
    queryFn: ({ signal }) => apiRequest(`/inspections/${encodeURIComponent(id)}`, { schema: inspectionDetailSchema, signal }) });
  const inspection = query.data?.inspection;
  const shown = query.data?.revisions.find((entry) => String(entry.version) === revision)?.snapshot ?? inspection;
  async function reload() { return (await query.refetch()).data?.inspection; }
  return <><Link to="/inspections" className="print-hidden mb-6 inline-block text-sm text-[#315248]">← Inspections</Link>
    <QueryState query={query}>{inspection && <>
      <div className="print-hidden"><PageIntro eyebrow="Inspection" title={`${inspection.asset.code} · ${inspection.template.name}`}
        action={<button className="button-secondary" onClick={() => window.print()}>Print report</button>}>
        Assigned to {inspection.worker.name}. {inspection.status === 'approved' ? 'This approved report is read-only.' : 'Checklist execution and report review.'}</PageIntro></div>
      {!revision && session.data.user.role === 'admin' && <AdminActions key={inspection.version} inspection={inspection} organizationId={organizationId} onReload={reload} />}
      <label className="print-hidden mt-6 block max-w-sm text-sm font-medium">Report version<select aria-label="Report version" className="input mt-2" value={revision} onChange={(event) => setRevision(event.target.value)}>
        <option value="">Current version ({inspection.version})</option>{query.data.revisions.filter((entry) => entry.version !== inspection.version).map((entry) =>
          <option key={entry.id} value={String(entry.version)}>Historical version {entry.version}</option>)}</select></label>
      {revision && <p className="mt-4 text-sm text-amber-800">Historical report · Version {revision}</p>}
      <InspectionReport inspection={shown} /><EvidencePanel inspection={shown} /><AuditHistory events={query.data.events} />
      {!revision && <AiPanel inspection={inspection} readOnly />}
    </>}</QueryState>
  </>;
}

export function InspectionDetailPage() {
  const { session } = useAuth();
  return session.data.user.role === 'worker' ? <WorkerInspectionDetail /> : <OnlineInspectionDetailPage />;
}
