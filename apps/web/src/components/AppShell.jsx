import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { ErrorNotice } from './ui.jsx';

export function AppShell() {
  const { session, logout } = useAuth();
  const { user, organization } = session.data;
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);
  const links = [['/', 'Dashboard'], ['/assets', 'Assets'], ...(user.role === 'admin' ? [['/team', 'Team']] : []), ['/status', 'System Status']];
  return <div className="min-h-screen bg-[#f6f6f0] text-stone-800">
    <header className="border-b border-[#dedfd4] bg-white">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-5 px-5 py-5 sm:px-8">
        <NavLink to="/" className="flex items-center gap-3 text-xl font-semibold tracking-tight text-[#203c33]">
          <img src="/favicon.svg" alt="" className="h-10 w-10" />FieldSync</NavLink>
        <div className="flex items-center gap-4"><div className="text-right text-sm"><p className="font-semibold">{user.name}</p>
          <p className="mt-1 text-xs text-stone-500">{organization.name} <span className="ml-2 rounded-full bg-[#eef0e6] px-2 py-1 capitalize text-[#315248]">{user.role}</span></p></div>
          <button className="button-secondary" disabled={pending} onClick={async () => {
            setPending(true); setError(null);
            try { await logout(); } catch (failure) { setError(failure); setPending(false); }
          }}>{pending ? 'Signing out…' : 'Log out'}</button>
        </div>
      </div>
    </header>
    <div className="mx-auto grid max-w-7xl lg:grid-cols-[220px_1fr]">
      <aside className="border-b border-[#dedfd4] p-5 lg:min-h-[calc(100vh-90px)] lg:border-b-0 lg:border-r lg:p-6">
        <nav aria-label="Main navigation" className="flex flex-wrap gap-2 lg:flex-col">
          {links.map(([to, label]) => <NavLink key={to} to={to} end={to === '/'}
            className={({ isActive }) => `rounded-xl px-4 py-3 text-sm font-medium transition ${isActive ? 'bg-[#163d35] text-white' : 'text-stone-600 hover:bg-[#e9ecdf]'}`}>{label}</NavLink>)}
        </nav>
        <details className="mt-8 text-xs text-stone-500"><summary className="cursor-pointer">Organization sign-in ID</summary>
          <p className="mt-3 select-all break-all rounded-lg bg-white p-3 font-mono leading-5">{organization.id}</p>
          <p className="mt-2 leading-5">Use this ID with your email when signing in. Share it with your team.</p></details>
      </aside>
      <main className="min-w-0 p-5 sm:p-8 lg:p-10"><ErrorNotice error={error} /><Outlet /></main>
    </div>
  </div>;
}
