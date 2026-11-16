import { useQuery } from '@tanstack/react-query';
import { fetchHealth } from '../api/health.js';
import { PageIntro } from '../components/ui.jsx';

export function SystemStatusPage() {
  const health = useQuery({ queryKey: ['health'], queryFn: fetchHealth, refetchInterval: 10000, refetchIntervalInBackground: false });
  const healthy = !health.isError && health.data?.status === 'ok';
  return <><PageIntro eyebrow="System status" title="Connections at a glance.">Live checks of the API, PostgreSQL, and Redis. Refreshes every ten seconds while this page is active.</PageIntro>
    <section className="panel max-w-2xl" aria-busy={health.isFetching}>
      <div aria-live="polite"><h2 className="text-xl font-semibold text-[#203c33]">{health.isPending ? 'Checking connections…' : healthy ? 'All systems responding' : 'A connection needs attention'}</h2>
        <p className="mt-3 text-sm leading-6 text-stone-500">{health.isError ? 'The API could not return a valid health response. Try again shortly.' : health.isPending ? 'Waiting for a live response.' : healthy ? 'Your database and Redis connections are available.' : 'The API is responding, but a dependency is unavailable.'}</p></div>
      <div className="my-6 divide-y divide-stone-100">{[['postgres', 'PostgreSQL'], ['redis', 'Redis']].map(([key, label]) => {
        const dependency = !health.isError && health.data?.dependencies[key];
        return <div key={key} className="flex justify-between gap-4 py-5"><p className="font-medium text-[#203c33]">{label}</p><div className="text-right text-sm">
          <p className={dependency?.status === 'up' ? 'text-emerald-700' : 'text-stone-500'}>{dependency ? dependency.status === 'up' ? 'Connected' : 'Unavailable' : 'Not confirmed'}</p>
          {dependency && <p className="mt-1 text-xs text-stone-400">{dependency.latencyMs} ms response</p>}</div></div>;
      })}</div>
      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-stone-100 pt-5"><p className="text-xs text-stone-400">{health.data ? `Last response ${new Date(health.data.timestamp).toLocaleTimeString()}` : 'No response yet'}</p>
        <button className="button-primary" disabled={health.isFetching} onClick={() => health.refetch()}>{health.isFetching ? 'Checking…' : 'Check again'}</button></div>
    </section>
  </>;
}
