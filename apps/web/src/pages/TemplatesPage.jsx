import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createTemplateSchema, updateTemplateSchema, templateSchema, templatesResponseSchema, templateDetailSchema } from '@fieldsync/contracts';
import { apiRequest } from '../api/client.js';
import { useAuth } from '../auth.jsx';
import { ErrorNotice, Field, PageIntro, QueryState } from '../components/ui.jsx';
import { useOnlineMutation, MutationNotice, AuditHistory } from '../components/inspection-ui.jsx';

function TemplateForm({ template, onDone, onCancel, onReload }) {
  const [draft, setDraft] = useState(template ?? { name: '', description: '', items: [{ id: crypto.randomUUID(), label: '' }], status: 'active' });
  const [error, setError] = useState(null);
  const mutation = useOnlineMutation(templateSchema, onDone);
  function submit(event) {
    event.preventDefault();
    const fields = { name: draft.name, description: draft.description, items: draft.items, mutationId: crypto.randomUUID() };
    const parsed = (template ? updateTemplateSchema : createTemplateSchema).safeParse(template
      ? { ...fields, status: draft.status, baseVersion: draft.version } : fields);
    if (!parsed.success) { setError(new Error(parsed.error.issues[0].message)); return; }
    setError(null); mutation.send(template ? `/templates/${template.id}` : '/templates', template ? 'PATCH' : 'POST', parsed.data);
  }
  return <form className="panel mb-6 space-y-5" onSubmit={submit}><h2 className="text-xl font-semibold">{template ? 'Edit template' : 'New template'}</h2>
    <ErrorNotice error={error} /><MutationNotice mutation={mutation} onReload={() => {
      if (window.confirm('Replace this form with the latest template? Unsaved changes will be discarded.')) onReload();
    }} />
    <fieldset disabled={mutation.blocked} className="space-y-5">
      <Field label="Template name" name="name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required maxLength={160} />
      <label className="block text-sm font-medium">Instructions<textarea aria-label="Instructions" className="input mt-2" value={draft.description} maxLength={2000} rows={3} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
      <div className="space-y-3"><h3 className="font-semibold">Checklist items</h3>{draft.items.map((item, index) => <div key={item.id} className="flex items-end gap-3">
        <div className="min-w-0 flex-1"><Field label={`Item ${index + 1}`} name={`item-${item.id}`} value={item.label} maxLength={240} required
          onChange={(event) => setDraft({ ...draft, items: draft.items.map((entry) => entry.id === item.id ? { ...entry, label: event.target.value } : entry) })} /></div>
        <button type="button" className="button-secondary" disabled={draft.items.length === 1} onClick={() => setDraft({ ...draft, items: draft.items.filter((entry) => entry.id !== item.id) })}>Remove</button>
      </div>)}<button type="button" className="button-secondary" disabled={draft.items.length >= 50}
        onClick={() => setDraft({ ...draft, items: [...draft.items, { id: crypto.randomUUID(), label: '' }] })}>+ Add item</button></div>
      {template && <label className="block text-sm font-medium">Status<select aria-label="Status" className="input mt-2" value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value })}>
        <option value="active">Active</option><option value="archived">Archived</option></select></label>}
      <p className="text-xs text-stone-500">Existing inspections keep the checklist version they were assigned.</p>
      <div className="flex gap-3"><button className="button-primary">{mutation.isPending ? 'Saving…' : 'Save template'}</button>
        <button type="button" className="button-secondary" onClick={onCancel}>Cancel</button></div>
    </fieldset></form>;
}
export function TemplatesPage() {
  const { session } = useAuth();
  const organizationId = session.data.organization.id;
  const [editing, setEditing] = useState(null);
  const [selected, setSelected] = useState(null);
  const query = useQuery({ queryKey: ['templates', organizationId, 'all'],
    queryFn: ({ signal }) => apiRequest('/templates?status=all', { schema: templatesResponseSchema, signal }) });
  const detail = useQuery({ queryKey: ['template', organizationId, selected], enabled: Boolean(selected),
    queryFn: ({ signal }) => apiRequest(`/templates/${selected}`, { schema: templateDetailSchema, signal }) });
  return <><PageIntro eyebrow="Inspection templates" title="A consistent checklist for every visit."
    action={!editing && <button className="button-primary" onClick={() => setEditing({ creating: true })}>+ New template</button>}>
    Define the checks your workers complete. Archive templates when they are no longer needed.</PageIntro>
    {editing && <TemplateForm key={editing.id ? `${editing.id}:${editing.version}` : 'new'} template={editing.creating ? null : editing}
      onReload={async () => { const result = await query.refetch(); const latest = result.data?.templates.find((entry) => entry.id === editing.id); if (latest) setEditing(latest); }}
      onCancel={() => setEditing(null)} onDone={(saved) => { setEditing(null); setSelected(saved.id); }} />}
    <QueryState query={query}><div className="grid gap-4 sm:grid-cols-2">{query.data?.templates.map((template) => <article className="panel" key={template.id}>
      <div className="flex justify-between gap-3"><h2 className="break-words font-semibold">{template.name}</h2><span className="text-xs capitalize text-stone-500">{template.status}</span></div>
      <p className="mt-3 text-sm text-stone-500">{template.items.length} checks · Version {template.version}</p>
      <p className="mt-2 whitespace-pre-wrap text-sm text-stone-600">{template.description}</p>
      <div className="mt-4 flex gap-3"><button className="button-secondary" onClick={() => setEditing(template)}>Edit</button>
        <button className="button-secondary" onClick={() => setSelected(template.id)}>History</button></div>
    </article>)}</div>{query.data?.templates.length === 0 && <p className="panel text-sm text-stone-500">Create your first template to start assigning inspections.</p>}</QueryState>
    {selected && <QueryState query={detail}>{detail.data && <AuditHistory events={detail.data.events} />}</QueryState>}
  </>;
}
