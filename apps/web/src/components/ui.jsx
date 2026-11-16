export function ErrorNotice({ error }) {
  return error ? <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
    {error.message || 'Something went wrong. Please try again.'}</p> : null;
}
export function Field({ label, name, errors = {}, ...props }) {
  return <label className="block text-sm font-medium text-stone-700">
    {label}<input name={name} className="input mt-2" aria-invalid={Boolean(errors[name])}
      aria-describedby={errors[name] ? `${name}-error` : undefined} {...props} />
    {errors[name] && <span id={`${name}-error`} className="mt-1 block text-xs text-red-700">{errors[name]}</span>}
  </label>;
}
export function formErrors(result) {
  return Object.fromEntries(result.error.issues.map((issue) => [issue.path[0] ?? 'form', issue.message]));
}
export function StatusBadge({ status }) {
  return <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${status === 'active' ? 'bg-emerald-50 text-emerald-800' : 'bg-stone-100 text-stone-600'}`}>
    {status === 'active' ? 'Active' : 'Archived'}</span>;
}
export function PageIntro({ eyebrow, title, children, action }) {
  return <div className="mb-8 flex flex-wrap items-start justify-between gap-4"><div>
    <p className="eyebrow">{eyebrow}</p><h1 className="mt-2 text-3xl font-semibold tracking-tight text-[#203c33]">{title}</h1>
    {children && <p className="mt-3 max-w-2xl text-sm leading-6 text-stone-500">{children}</p>}
  </div>{action}</div>;
}
export function QueryState({ query, children }) {
  if (query.isPending) return <p role="status" className="py-8 text-sm text-stone-500">Loading…</p>;
  if (query.isError) return <div><ErrorNotice error={query.error} /><button className="button-secondary mt-3" onClick={() => query.refetch()}>Try again</button></div>;
  return children;
}
