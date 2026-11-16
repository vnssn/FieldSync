import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { assetDetailSchema } from '@fieldsync/contracts';
import { apiRequest } from '../api/client.js';
import { useAuth } from '../auth.jsx';
import { PageIntro, QueryState, StatusBadge } from '../components/ui.jsx';
import { AssetForm } from '../components/AssetForm.jsx';

export function AssetDetailPage() {
  const { id } = useParams();
  const { session } = useAuth();
  const [editing, setEditing] = useState(null);
  const query = useQuery({ queryKey: ['asset', session.data.organization.id, id],
    queryFn: ({ signal }) => apiRequest(`/assets/${encodeURIComponent(id)}`, { schema: assetDetailSchema, signal }) });
  const asset = query.data?.asset;
  return <><Link to="/assets" className="mb-6 inline-block text-sm text-[#315248] hover:underline">← Asset directory</Link>
    <QueryState query={query}>{asset && <>
      <PageIntro eyebrow={asset.code} title={asset.name} action={session.data.user.role === 'admin' && !editing &&
        <button className="button-primary" onClick={() => setEditing(asset)}>Edit asset</button>}>Asset details and a complete change history.</PageIntro>
      {editing && <AssetForm asset={editing} onCancel={() => setEditing(null)} onDone={() => setEditing(null)} />}
      <div className="panel"><div className="mb-6 flex items-center justify-between"><StatusBadge status={asset.status} /><span className="text-xs text-stone-400">Version {asset.version}</span></div>
        <dl className="grid gap-6 sm:grid-cols-2">{[['Category', asset.category], ['Location', asset.location], ['Created', new Date(asset.createdAt).toLocaleString()], ['Last updated', new Date(asset.updatedAt).toLocaleString()]].map(([label, value]) =>
          <div key={label}><dt className="text-xs uppercase tracking-wide text-stone-400">{label}</dt><dd className="mt-2 text-sm font-medium text-stone-700">{value}</dd></div>)}</dl>
      </div>
      <section className="panel mt-6"><h2 className="mb-6 text-xl font-semibold text-[#203c33]">Activity history</h2>
        <ol className="ml-2 border-l border-stone-200">{query.data.events.map((event) => <li key={event.id} className="relative pb-8 pl-6 last:pb-0">
          <span aria-hidden="true" className="absolute -left-1.5 top-1.5 h-3 w-3 rounded-full border-2 border-white bg-[#7b8c70]" />
          <p className="text-sm font-semibold text-[#203c33]"><span className="capitalize">{event.eventType}</span> by {event.actorName}</p>
          <time dateTime={event.createdAt} className="mt-1 block text-xs text-stone-400">{new Date(event.createdAt).toLocaleString()}</time>
          <dl className="mt-3 space-y-2 rounded-xl bg-stone-50 p-3 text-xs">{Object.entries(event.changes).map(([field, change]) =>
            <div key={field} className="flex flex-wrap gap-x-3 gap-y-1"><dt className="min-w-16 font-medium capitalize text-stone-600">{field}</dt>
              <dd className="break-words text-stone-500">{change.before !== null && <><span>{change.before}</span><span className="mx-2">→</span></>}<span className="text-stone-800">{change.after}</span></dd></div>)}</dl>
        </li>)}</ol>
      </section>
    </>}</QueryState>
  </>;
}
