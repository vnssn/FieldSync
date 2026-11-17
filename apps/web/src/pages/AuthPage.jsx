import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { registerOrgSchema, loginSchema } from '@fieldsync/contracts';
import { useAuth } from '../auth.jsx';
import { ErrorNotice, Field, formErrors } from '../components/ui.jsx';

export function AuthPage({ register = false }) {
  const { session, expired, authenticate } = useAuth();
  const [error, setError] = useState(null);
  const [errors, setErrors] = useState({});
  const [pending, setPending] = useState(false);
  if (session.data && !expired) return <Navigate to="/" replace />;
  async function submit(event) {
    event.preventDefault(); setError(null);
    const input = Object.fromEntries(new FormData(event.currentTarget));
    const result = (register ? registerOrgSchema : loginSchema).safeParse(input);
    if (!result.success) { setErrors(formErrors(result)); return; }
    setErrors({}); setPending(true);
    try { await authenticate(register ? '/auth/register-org' : '/auth/login', result.data); }
    catch (failure) { setError(failure); }
    finally { setPending(false); }
  }
  return <main className="grid min-h-screen bg-[#f6f6f0] lg:grid-cols-2">
    <section className="flex flex-col justify-between bg-[#163d35] p-8 text-white sm:p-14 lg:p-20">
      <div className="flex items-center gap-3 text-xl font-semibold"><img src="/favicon.svg" alt="" className="h-10 w-10" />FieldSync</div>
      <div className="my-12 max-w-lg"><p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#b8cba6]">Your team. Your workspace.</p>
        <h1 className="mt-6 text-4xl font-medium leading-tight tracking-tight sm:text-5xl">Good fieldwork starts<br />with a clear picture.</h1>
        <p className="mt-6 max-w-sm text-base leading-7 text-[#c9d6cc]">Keep your assets organized, your team connected, and every change on record.</p></div>
      <p className="text-xs text-[#b8cba6]">FieldSync / Assets & team management</p>
    </section>
    <section className="flex items-center justify-center p-6 sm:p-12"><div className="w-full max-w-md">
      <h2 className="text-3xl font-semibold tracking-tight text-[#203c33]">{register ? 'Create your workspace' : 'Welcome back'}</h2>
      <p className="mb-8 mt-3 text-sm leading-6 text-stone-500">{register ? 'Set up your organization and its first administrator.' : 'Sign in using your organization ID, email, and password.'}</p>
      <ErrorNotice error={error} />
      <form onSubmit={submit} className="mt-5 space-y-5">
        {register ? <><Field label="Organization name" name="organizationName" errors={errors} required maxLength={120} autoComplete="organization" />
          <Field label="Your name" name="name" errors={errors} required maxLength={120} autoComplete="name" /></>
          : <Field label="Organization ID" name="organizationId" errors={errors} required placeholder="Ask your administrator for this ID" autoComplete="off" />}
        <Field label="Email" name="email" type="email" errors={errors} required autoComplete="username" maxLength={254} />
        <Field label="Password" name="password" type="password" errors={errors} required minLength={12} maxLength={128} autoComplete={register ? 'new-password' : 'current-password'} />
        {register && <p className="text-xs text-stone-500">Use at least 12 characters. No email verification is required.</p>}
        <button className="button-primary w-full" disabled={pending}>{pending ? 'Please wait…' : register ? 'Create workspace' : 'Sign in'}</button>
      </form>
      <p className="mt-7 text-center text-sm text-stone-500">{register ? 'Already have a workspace? ' : 'Starting a new team? '}
        <Link className="font-semibold text-[#163d35] underline underline-offset-4" to={register ? '/login' : '/register'}>{register ? 'Sign in' : 'Create a workspace'}</Link></p>
    </div></section>
  </main>;
}
