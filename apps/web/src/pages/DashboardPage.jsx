import { Link,useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { analyticsSchema } from '@fieldsync/contracts';
import { apiRequest } from '../api/client.js';
import { useAuth } from '../auth.jsx';
import { PageIntro, QueryState } from '../components/ui.jsx';

export function DashboardPage() {
  const { session } = useAuth();
  const { user, organization } = session.data;
  const [params,setParams]=useSearchParams();
  const days=['7','30','90'].includes(params.get('days'))?params.get('days'):'30',assetId=params.get('assetId') ?? '';
  const search=new URLSearchParams({ days }); if (assetId) search.set('assetId',assetId);
  const query = useQuery({ queryKey: ['analytics', organization.id,user.id,days,assetId],
    queryFn: ({ signal }) => apiRequest(`/analytics?${search}`, { schema: analyticsSchema, signal }) });
  const data=query.data;
  const activityMaximum=Math.max(1,...(data?.activity.flatMap((day)=>[day.created,day.submitted]) ?? []));
  function filter(key,value) { const next=new URLSearchParams(params); if(value) next.set(key,value); else next.delete(key); setParams(next); }
  return <><PageIntro eyebrow="Workspace overview" title={`Welcome, ${user.name.split(' ')[0]}.`}>
    Here’s the current picture of {organization.name}.</PageIntro>
    <div className="mb-6 flex flex-wrap gap-4"><label className="text-sm font-medium">Inspection period<select aria-label="Analytics period" className="input mt-2" value={days} onChange={(event)=>filter('days',event.target.value)}>
      {['7','30','90'].map((value)=><option key={value} value={value}>Past {value} days</option>)}</select></label>
      <label className="min-w-48 max-w-full text-sm font-medium">Asset<select aria-label="Analytics asset" className="input mt-2" value={assetId} onChange={(event)=>filter('assetId',event.target.value)}>
        <option value="">All accessible assets</option>{data?.byAsset.map((asset)=><option key={asset.id} value={asset.id}>{asset.code} · {asset.name}</option>)}
      </select></label></div>
    <QueryState query={query}>{data && <>
      <p className="mb-4 text-sm text-stone-500">{data.scope==='assigned'?'Your assigned inspections':'Workspace inspections'} · current status of inspections created in the past {days} UTC days. Asset counts show the current directory.</p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[['Assets',data.assets.total],['Inspections',data.inspections.total],['Awaiting review',data.inspections.byStatus.submitted],['Failed checks',data.inspections.failedChecks]].map(([label,count])=>
          <div key={label} className="panel"><p className="text-sm text-stone-500">{label}</p><p className="mt-4 text-4xl font-semibold text-[#203c33]" aria-label={`${label}: ${count}`}>{count}</p></div>)}
      </div>
      <section className="panel mt-6"><h2 className="text-xl font-semibold">Inspection status</h2><div className="mt-4 grid gap-3 sm:grid-cols-3">
        {Object.entries(data.inspections.byStatus).map(([status,count])=><div key={status} className="flex justify-between gap-3 rounded-xl bg-stone-50 p-3 text-sm"><span className="capitalize">{status.replaceAll('_',' ')}</span><strong>{count}</strong></div>)}
      </div><p className="mt-4 text-sm text-stone-500">Average time to latest submission: {data.inspections.averageSubmissionHours===null?'No submissions yet':`${data.inspections.averageSubmissionHours} hours`}. Active assets: {data.assets.active}; archived: {data.assets.archived}.</p></section>
      <section className="panel mt-6"><h2 className="text-xl font-semibold">Daily activity</h2><p className="mt-2 text-sm text-stone-500">Created inspections and latest submission dates · UTC</p>
        <div className="mt-5 flex h-32 items-end gap-px lg:gap-1" role="img" aria-label={`Daily inspection activity for the past ${days} days`}>
          {data.activity.map((day)=><div key={day.date} className="flex h-full min-w-0 flex-1 items-end lg:gap-px" title={`${day.date}: ${day.created} created, ${day.submitted} submitted`}>
            <div className="flex-1 rounded-t bg-[#315248]" style={{ height:`${day.created/activityMaximum*100}%`,minHeight:day.created?'2px':0 }} />
            <div className="flex-1 rounded-t bg-[#c49c58]" style={{ height:`${day.submitted/activityMaximum*100}%`,minHeight:day.submitted?'2px':0 }} /></div>)}
        </div><p className="mt-3 text-xs text-stone-500">Green: created · Gold: submitted · {data.activity[0]?.date} to {data.activity.at(-1)?.date}</p>
      </section>
      <section className="panel mt-6"><h2 className="text-xl font-semibold">Asset inspection summary</h2><p className="mt-2 text-sm text-stone-500">Up to 50 assets, ordered by failed checks and inspection count.</p>
        <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[520px] text-left text-sm"><thead><tr className="border-b text-stone-500"><th className="p-2">Asset</th><th className="p-2">Inspections</th><th className="p-2">Review</th><th className="p-2">Approved</th><th className="p-2">Failed checks</th></tr></thead>
          <tbody>{data.byAsset.map((asset)=><tr key={asset.id} className="border-b last:border-0"><td className="p-2"><Link className="text-[#315248] underline" to={`/assets/${asset.id}`}>{asset.code}</Link><p className="text-xs text-stone-500">{asset.name} · {asset.status}</p></td>
            <td className="p-2">{asset.inspections}</td><td className="p-2">{asset.submitted}</td><td className="p-2">{asset.approved}</td><td className="p-2">{asset.failedChecks}</td></tr>)}</tbody></table></div>
        {!data.byAsset.length && <p className="mt-4 text-sm text-stone-500">No assets in this scope.</p>}
      </section>
      <p className="mt-3 text-xs text-stone-500">Updated {new Date(data.asOf).toLocaleString()}. Counts describe recorded inspections; they do not predict equipment failure.</p>
    </>}</QueryState>
    <div className="panel mt-8"><p className="eyebrow">Keep things moving</p><h2 className="mt-3 text-xl font-semibold text-[#203c33]">A reliable record for every inspection.</h2>
      <p className="mb-6 mt-3 max-w-xl text-sm leading-6 text-stone-500">{user.role === 'admin' ? 'Assign checklists to your workers and review their submitted reports.' : 'Complete checklists and save your progress on this device. Reports synchronize when you reconnect.'}</p>
      <div className="flex flex-wrap gap-3"><Link className="button-primary inline-flex" to="/inspections">Open inspections</Link>
        {user.role === 'admin' && <Link className="button-secondary" to="/inspections?status=submitted">Review submitted reports</Link>}
        <Link className="button-secondary" to="/assets">Asset directory</Link></div></div>
  </>;
}
