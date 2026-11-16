import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { usersResponseSchema, createWorkerSchema, userPublicSchema } from '@fieldsync/contracts';
import { apiRequest } from '../api/client.js';
import { useAuth } from '../auth.jsx';
import { PageIntro, QueryState, ErrorNotice, Field, formErrors } from '../components/ui.jsx';

export function TeamPage() {
  const { session } = useAuth();
  const organizationId = session.data.organization.id;
  const client = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [errors, setErrors] = useState({});
  const [notice, setNotice] = useState('');
  const query = useQuery({ queryKey: ['users', organizationId], queryFn: ({ signal }) => apiRequest('/users', { schema: usersResponseSchema, signal }) });
  const mutation = useMutation({ mutationFn: (body) => apiRequest('/users', { method: 'POST', body, schema: userPublicSchema }),
    onSuccess: async (user) => {
      await client.invalidateQueries({ queryKey: ['users', organizationId] });
      setCreating(false); setNotice(`${user.name} can now sign in. Share the organization ID and their password directly.`);
    } });
  return <><PageIntro eyebrow="People & access" title="Your team, connected."
    action={!creating && <button className="button-primary" onClick={() => { setCreating(true); mutation.reset(); setErrors({}); setNotice(''); }}>+ Add worker</button>}>
    Workers can browse assets and their history. Administrators manage the directory and team.</PageIntro>
    {notice && <p role="status" className="mb-6 rounded-xl bg-emerald-50 p-4 text-sm text-emerald-800">{notice}</p>}
    {creating && <form className="panel mb-6 space-y-5" onSubmit={(event) => {
      event.preventDefault(); const result = createWorkerSchema.safeParse(Object.fromEntries(new FormData(event.currentTarget)));
      if (!result.success) { setErrors(formErrors(result)); return; }
      setErrors({}); mutation.mutate(result.data);
    }}><h2 className="text-xl font-semibold text-[#203c33]">Add a worker</h2><ErrorNotice error={mutation.error} />
      <div className="grid gap-5 sm:grid-cols-2"><Field label="Full name" name="name" required maxLength={120} errors={errors} autoComplete="off" />
        <Field label="Email" name="email" type="email" required maxLength={254} errors={errors} autoComplete="off" /></div>
      <Field label="Password" name="password" type="password" required minLength={12} maxLength={128} errors={errors} autoComplete="new-password" />
      <p className="text-xs leading-5 text-stone-500">Use at least 12 characters. Share these credentials directly with the worker; no email is sent.</p>
      <div className="flex gap-3"><button className="button-primary" disabled={mutation.isPending}>{mutation.isPending ? 'Adding…' : 'Create worker'}</button>
        <button type="button" className="button-secondary" disabled={mutation.isPending} onClick={() => setCreating(false)}>Cancel</button></div>
    </form>}
    <div className="panel"><QueryState query={query}><div className="divide-y divide-stone-100">{query.data?.users.map((user) =>
      <div key={user.id} className="flex flex-wrap items-center justify-between gap-4 py-5 first:pt-0 last:pb-0"><div>
        <p className="text-sm font-semibold text-[#203c33]">{user.name}{user.id === session.data.user.id && <span className="ml-2 text-xs font-normal text-stone-400">You</span>}</p>
        <p className="mt-1 break-all text-sm text-stone-500">{user.email}</p></div><span className="rounded-full bg-[#eef0e6] px-3 py-1 text-xs font-medium capitalize text-[#315248]">{user.role}</span>
      </div>)}</div></QueryState></div>
    <p className="mt-6 break-all text-xs text-stone-500">Organization sign-in ID: <span className="select-all font-mono">{organizationId}</span></p>
  </>;
}
