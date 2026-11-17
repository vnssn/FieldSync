import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { INSPECTION_STATUSES, createInspectionSchema, inspectionSchema, inspectionsResponseSchema, templatesResponseSchema, assetsResponseSchema, usersResponseSchema } from '@fieldsync/contracts';
import { useAuth } from '../auth.jsx';
import { apiRequest } from '../api/client.js';
import { ErrorNotice, PageIntro, QueryState } from '../components/ui.jsx';
import { useOnlineMutation, MutationNotice, InspectionStatus } from '../components/inspection-ui.jsx';
import { WorkerInspections } from './WorkerInspections.jsx';

function AssignmentForm({ organizationId, onDone, onCancel }) {
  const [error, setError] = useState(null);
  const mutation = useOnlineMutation(inspectionSchema, onDone);
  const assets = useQuery({ queryKey: ['assets', organizationId, 'active', ''], queryFn: ({ signal }) => apiRequest('/assets', { schema: assetsResponseSchema, signal }) });
  const templates = useQuery({ queryKey: ['templates', organizationId, 'active'], queryFn: ({ signal }) => apiRequest('/templates', { schema: templatesResponseSchema, signal }) });
  const users = useQuery({ queryKey: ['users', organizationId], queryFn: ({ signal }) => apiRequest('/users', { schema: usersResponseSchema, signal }) });
  const workers = users.data?.users.filter((user) => user.role === 'worker') ?? [];
  const ready = Boolean(assets.data?.assets.length && templates.data?.templates.length && workers.length);
  return <form className="panel mb-6 space-y-5" onSubmit={(event) => {
    event.preventDefault();
    const parsed = createInspectionSchema.safeParse({ ...Object.fromEntries(new FormData(event.currentTarget)), mutationId: crypto.randomUUID() });
    if (!parsed.success) { setError(new Error(parsed.error.issues[0].message)); return; }
    setError(null); mutation.send('/inspections', 'POST', parsed.data);
  }}><h2 className="text-xl font-semibold">Assign inspection</h2><ErrorNotice error={error ?? assets.error ?? templates.error ?? users.error} />
    <MutationNotice mutation={mutation} /><fieldset disabled={mutation.blocked || !ready} className="space-y-5">
      {[['assetId', 'Asset', assets.data?.assets.map((asset) => [asset.id, `${asset.code} · ${asset.name}`])],
        ['templateId', 'Template', templates.data?.templates.map((template) => [template.id, template.name])],
        ['assignedTo', 'Worker', workers.map((worker) => [worker.id, worker.name])]].map(([name, label, options]) => <label key={name} className="block text-sm font-medium">{label}
        <select name={name} aria-label={label} className="input mt-2" required defaultValue=""><option value="" disabled>Choose {label.toLowerCase()}</option>
          {options?.map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></label>)}
      <button className="button-primary">{mutation.isPending ? 'Assigning…' : 'Assign inspection'}</button>
    </fieldset>{!ready && <p className="text-sm text-stone-500">An active asset, active template, and worker account are required.</p>}
    <button type="button" className="button-secondary" disabled={mutation.blocked} onClick={onCancel}>Cancel</button></form>;
}
function OnlineInspectionsPage() {
  const { session } = useAuth();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const organizationId = session.data.organization.id;
  const allowed = ['all', ...Object.values(INSPECTION_STATUSES)];
  const status = allowed.includes(params.get('status')) ? params.get('status') : 'all';
  const query = useQuery({ queryKey: ['inspections', organizationId, status],
    queryFn: ({ signal }) => apiRequest(`/inspections?${new URLSearchParams({ status })}`, { schema: inspectionsResponseSchema, signal }) });
  return <><PageIntro eyebrow="Online inspections" title={status === 'submitted' ? 'Reports ready for review.' : 'Every check, accounted for.'}
    action={session.data.user.role === 'admin' && !creating && <button className="button-primary" onClick={() => setCreating(true)}>+ Assign inspection</button>}>
    {session.data.user.role === 'admin' ? 'Assign work and review submitted reports.' : 'Complete your assigned checklists and submit them for review.'}</PageIntro>
    {creating && <AssignmentForm organizationId={organizationId} onCancel={() => setCreating(false)} onDone={(saved) => navigate(`/inspections/${saved.id}`)} />}
    <label className="mb-5 block max-w-sm text-sm font-medium">Status<select aria-label="Status" className="input mt-2" value={status} onChange={(event) => setParams({ status: event.target.value })}>
      {allowed.map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select></label>
    <QueryState query={query}><div className="space-y-4">{query.data?.inspections.map((inspection) => <Link key={inspection.id} to={`/inspections/${inspection.id}`} className="panel block hover:border-[#7b8c70]">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="break-words font-semibold">{inspection.asset.code} · {inspection.asset.name}</h2>
        <p className="mt-2 text-sm text-stone-500">{inspection.template.name} · {inspection.worker.name}</p></div><InspectionStatus status={inspection.status} /></div>
    </Link>)}</div>{query.data?.inspections.length === 0 && <p className="panel text-sm text-stone-500">No inspections match this status.</p>}</QueryState>
  </>;
}

export function InspectionsPage() {
  const { session } = useAuth();
  return session.data.user.role === 'worker' ? <WorkerInspections /> : <OnlineInspectionsPage />;
}
