import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { assetsResponseSchema } from '@fieldsync/contracts';
import { apiRequest } from '../api/client.js';
import { useAuth } from '../auth.jsx';
import { PageIntro, QueryState } from '../components/ui.jsx';

export function DashboardPage() {
  const { session } = useAuth();
  const { user, organization } = session.data;
  const query = useQuery({ queryKey: ['assets', organization.id, 'all', ''],
    queryFn: ({ signal }) => apiRequest('/assets?status=all', { schema: assetsResponseSchema, signal }) });
  const assets = query.data?.assets ?? [];
  return <><PageIntro eyebrow="Workspace overview" title={`Welcome, ${user.name.split(' ')[0]}.`}>
    Here’s the current picture of {organization.name}.</PageIntro>
    <QueryState query={query}><div className="grid gap-4 sm:grid-cols-3">
      {[['All assets', assets.length], ['Active', assets.filter((a) => a.status === 'active').length], ['Archived', assets.filter((a) => a.status === 'archived').length]].map(([label, count]) =>
        <div key={label} className="panel"><p className="text-sm text-stone-500">{label}</p><p className="mt-4 text-4xl font-semibold text-[#203c33]">{count}</p></div>)}
    </div></QueryState>
    <div className="panel mt-8"><p className="eyebrow">Keep things moving</p><h2 className="mt-3 text-xl font-semibold text-[#203c33]">A reliable record for every inspection.</h2>
      <p className="mb-6 mt-3 max-w-xl text-sm leading-6 text-stone-500">{user.role === 'admin' ? 'Assign checklists to your workers and review their submitted reports.' : 'Complete checklists and save your progress on this device. Reports synchronize when you reconnect.'}</p>
      <div className="flex flex-wrap gap-3"><Link className="button-primary inline-flex" to="/inspections">Open inspections</Link>
        {user.role === 'admin' && <Link className="button-secondary" to="/inspections?status=submitted">Review submitted reports</Link>}
        <Link className="button-secondary" to="/assets">Asset directory</Link></div></div>
  </>;
}
