import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { assetsResponseSchema } from '@fieldsync/contracts';
import { apiRequest } from '../api/client.js';
import { useAuth } from '../auth.jsx';
import { PageIntro, QueryState, StatusBadge } from '../components/ui.jsx';
import { AssetForm } from '../components/AssetForm.jsx';

export function AssetsPage() {
  const { session } = useAuth();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const status = ['active', 'archived', 'all'].includes(params.get('status')) ? params.get('status') : 'active';
  const q = (params.get('q') ?? '').slice(0, 120);
  const query = useQuery({ queryKey: ['assets', session.data.organization.id, status, q],
    queryFn: ({ signal }) => apiRequest(`/assets?${new URLSearchParams({ status, q })}`, { schema: assetsResponseSchema, signal }) });
  return <><PageIntro eyebrow="Asset directory" title="Everything in its place."
    action={session.data.user.role === 'admin' && !creating && <button className="button-primary" onClick={() => setCreating(true)}>+ New asset</button>}>
    Find equipment, keep details current, and follow the history of every change.</PageIntro>
    {creating && <AssetForm onCancel={() => setCreating(false)} onDone={(asset) => navigate(`/assets/${asset.id}`)} />}
    <div className="panel">
      <form className="mb-6 flex flex-wrap items-end gap-3" onSubmit={(event) => {
        event.preventDefault(); const data = new FormData(event.currentTarget);
        setParams({ status: data.get('status'), q: data.get('q').trim() });
      }}>
        <label className="min-w-48 flex-1 text-sm font-medium">Search assets<input key={q} name="q" defaultValue={q} maxLength={120} className="input mt-2" placeholder="Code, name, category, or location" /></label>
        <label className="text-sm font-medium">Status<select key={status} name="status" defaultValue={status} className="input mt-2">
          <option value="active">Active</option><option value="archived">Archived</option><option value="all">All assets</option>
        </select></label><button className="button-secondary">Apply filters</button>
      </form>
      <QueryState query={query}>
        {query.data?.assets.length ? <div>
          <div className="divide-y divide-stone-100 sm:hidden">{query.data.assets.map((asset) =>
            <Link key={asset.id} to={`/assets/${asset.id}`} className="block py-5 first:pt-1">
              <div className="flex items-start justify-between gap-3"><p className="min-w-0 break-words text-sm font-semibold text-[#163d35]">{asset.name}</p><span className="shrink-0"><StatusBadge status={asset.status} /></span></div>
              <p className="mt-2 font-mono text-xs text-stone-500">{asset.code}</p>
              <p className="mt-3 text-xs leading-5 text-stone-500">{asset.category}<br />{asset.location}</p>
            </Link>)}</div>
          <div className="hidden overflow-x-auto sm:block"><table className="w-full text-left text-sm">
          <thead className="border-b border-stone-200 text-xs uppercase tracking-wide text-stone-400"><tr>{['Asset', 'Category', 'Location', 'Status'].map((label) => <th key={label} className="px-3 pb-4 font-medium">{label}</th>)}</tr></thead>
          <tbody className="divide-y divide-stone-100">{query.data.assets.map((asset) => <tr key={asset.id} className="hover:bg-stone-50">
            <td className="p-3"><Link to={`/assets/${asset.id}`} className="block py-2 font-semibold text-[#163d35] underline-offset-4 hover:underline">{asset.name}<span className="mt-1 block font-mono text-xs font-normal text-stone-500">{asset.code}</span></Link></td>
            <td className="p-3 text-stone-600">{asset.category}</td><td className="p-3 text-stone-600">{asset.location}</td><td className="p-3"><StatusBadge status={asset.status} /></td>
          </tr>)}</tbody></table></div><p className="mt-4 text-xs text-stone-400">{query.data.assets.length} asset{query.data.assets.length === 1 ? '' : 's'}</p></div>
          : <div className="py-12 text-center"><h2 className="font-semibold text-[#203c33]">No assets found</h2><p className="mt-2 text-sm text-stone-500">Try another filter{session.data.user.role === 'admin' ? ' or add your first asset.' : '.'}</p></div>}
      </QueryState>
    </div>
  </>;
}
