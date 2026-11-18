import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../api/client.js';
import { ErrorNotice } from './ui.jsx';

export function useOnlineMutation(schema, onSaved) {
  const client = useQueryClient();
  const [attempt, setAttempt] = useState(null);
  const mutation = useMutation({
    mutationFn: ({ path, method, body }) => apiRequest(path, { method, body, schema }),
    onSuccess: async (saved) => {
      setAttempt(null);
      onSaved?.(saved);
      await Promise.all(['templates', 'template', 'inspections', 'inspection'].map((key) => client.invalidateQueries({ queryKey: [key] })));
    },
    onError: (error) => { if (error.status && error.status < 500) setAttempt(null); },
  });
  return { ...mutation, blocked: mutation.isPending || Boolean(attempt),
    retry: attempt && mutation.isError ? () => mutation.mutate(attempt) : null,
    send(path, method, body) {
      if (attempt) return;
      const next = { path, method, body };
      setAttempt(next); mutation.mutate(next);
    } };
}
export function MutationNotice({ mutation, onReload }) {
  return <div className="space-y-3"><ErrorNotice error={mutation.error} />
    {mutation.retry && <button type="button" className="button-secondary" onClick={mutation.retry}>Retry unconfirmed save</button>}
    {mutation.error?.code === 'VERSION_CONFLICT' && <p className="text-sm text-stone-600">Your edits are still here. Reload the latest version and review it before trying again.
      {onReload && <button type="button" className="button-secondary ml-3" onClick={onReload}>Reload and review</button>}</p>}
  </div>;
}
export function InspectionStatus({ status }) {
  const color = status === 'approved' ? 'bg-emerald-50 text-emerald-800'
    : status === 'changes_requested' ? 'bg-amber-50 text-amber-900' : 'bg-stone-100 text-stone-700';
  return <span className={`inline-block rounded-full px-3 py-1 text-xs font-semibold ${color}`}>{status.replaceAll('_', ' ')}</span>;
}
export function AuditHistory({ events }) {
  const labels = { answers: 'Checklist', reportText: 'Summary', assignedTo: 'Assignment', worker: 'Worker',
    reviewNote: 'Review note', submittedAt: 'Submission time', approvedAt: 'Approval time', approvedBy: 'Reviewer',
    asset: 'Asset', template: 'Template', status: 'Status', name: 'Name', description: 'Instructions', items: 'Checklist items', aiSources:'Reviewed assistance' };
  return <section className="panel mt-6 print-hidden"><h2 className="mb-4 text-xl font-semibold">Activity history</h2>
    <ol className="space-y-4">{events.map((event) => <li key={event.id} className="border-b border-stone-100 pb-4 last:border-0">
      <p className="text-sm"><strong className="capitalize">{event.eventType.replaceAll('_', ' ')}</strong> by {event.actorName} · Version {event.version}</p>
      <time dateTime={event.createdAt} className="text-xs text-stone-500">{new Date(event.createdAt).toLocaleString()}</time>
      <p className="mt-1 text-xs text-stone-500">Changed: {Object.keys(event.details.changes).map((field) => labels[field] ?? field).join(', ')}</p>
      {event.details.note && <p className="mt-2 whitespace-pre-wrap text-sm">{event.details.note}</p>}
    </li>)}</ol></section>;
}
export function InspectionReport({ inspection }) {
  return <section className="panel report mt-6 break-words"><div className="flex flex-wrap items-center justify-between gap-3">
    <h2 className="text-xl font-semibold">Inspection report</h2><InspectionStatus status={inspection.status} /></div>
    <p className="mt-4 font-semibold">{inspection.asset.code} · {inspection.asset.name}</p>
    <p className="mt-1 text-sm text-stone-500">{inspection.asset.category} · {inspection.asset.location}</p>
    <p className="mt-3 text-sm">{inspection.template.name} · Template version {inspection.template.version}<br />Inspector: {inspection.worker.name} · Inspection version {inspection.version}</p>
    {inspection.template.description && <p className="mt-3 whitespace-pre-wrap text-sm text-stone-600">{inspection.template.description}</p>}
    <ol className="mt-6 space-y-4">{inspection.template.items.map((item, index) => {
      const answer = inspection.answers.find((entry) => entry.itemId === item.id);
      return <li key={item.id} className="rounded-xl border border-stone-200 p-4"><div className="flex flex-wrap justify-between gap-2">
        <strong className="text-sm">{index + 1}. {item.label}</strong><span className="text-sm capitalize">{answer?.outcome?.replaceAll('_', ' ') ?? 'Unanswered'}</span></div>
        {answer?.notes && <p className="mt-2 whitespace-pre-wrap text-sm text-stone-600">{answer.notes}</p>}</li>;
    })}</ol>
    {inspection.reportText && <div className="mt-6"><h3 className="font-semibold">Inspector summary</h3><p className="mt-2 whitespace-pre-wrap text-sm">{inspection.reportText}</p></div>}
    {!!inspection.evidence?.length && <div className="mt-6"><h3 className="font-semibold">Evidence</h3><ul className="mt-2 text-sm">{inspection.evidence.map((file)=><li key={file.id}>{file.name} · {file.mimeType} · {file.size} bytes</li>)}</ul></div>}
    {inspection.reviewNote && <div className="mt-6"><h3 className="font-semibold">Admin review</h3><p className="mt-2 whitespace-pre-wrap text-sm">{inspection.reviewNote}</p></div>}
    {!!inspection.aiSources?.length && <div className="mt-6"><h3 className="font-semibold">Reviewed assistance provenance</h3><ul className="mt-2 text-xs text-stone-500 space-y-1">
      {inspection.aiSources.map((source)=><li key={source.artifactId}>{source.kind} · {source.mode==='fallback'?'Manual fallback':source.model} · source v{source.sourceVersion} · human-reviewed at v{source.appliedVersion}</li>)}</ul></div>}
    {inspection.submittedAt && <p className="mt-6 text-xs text-stone-500">Submitted: {new Date(inspection.submittedAt).toLocaleString()}</p>}
    {inspection.approvedAt && <p className="mt-2 text-xs text-stone-500">Approved: {new Date(inspection.approvedAt).toLocaleString()}</p>}
  </section>;
}
