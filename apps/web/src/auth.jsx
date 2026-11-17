import { createContext, Fragment, useContext, useEffect, useState } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { authResponseSchema } from '@fieldsync/contracts';
import { apiRequest } from './api/client.js';
import { ErrorNotice } from './components/ui.jsx';
import { readSession, writeSession, sessionKey, sessionEvent, sessionLock, finishLogout } from './offline/session.js';

const AuthContext = createContext(null);
export function AuthProvider({ children }) {
  const queryClient = useQueryClient();
  const [local, setLocal] = useState(readSession);
  useEffect(() => {
    function changed(event) {
      if (event.type === 'storage' && event.key !== sessionKey) return;
      const next = readSession(); setLocal(next);
      const previous = queryClient.getQueryData(['session']);
      const data = next.loggedOut ? null : next.session;
      if (previous?.user.id !== data?.user.id || previous?.organization.id !== data?.organization.id || previous?.user.role !== data?.user.role) {
        queryClient.cancelQueries();
        queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'session' });
      }
      queryClient.setQueryData(['session'], data);
    }
    window.addEventListener('storage', changed); window.addEventListener(sessionEvent, changed);
    return () => { window.removeEventListener('storage', changed); window.removeEventListener(sessionEvent, changed); };
  }, [queryClient]);
  const session = useQuery({
    queryKey: ['session'],
    initialData: local.session ?? (local.loggedOut ? null : undefined),
    queryFn: async ({ signal }) => {
      return sessionLock(async () => {
        const cached = readSession();
        if (cached.loggedOut) { if (navigator.onLine) await finishLogout(apiRequest); return null; }
        try {
          const data = await apiRequest('/auth/me', { schema: authResponseSchema, signal });
          writeSession({ session: data, expired: false, loggedOut: false, pendingLogout: false }); return data;
        } catch (error) {
          if (error.status === 401) { writeSession({ ...cached, expired: true }); return cached.session; }
          if (cached.session && (!error.status || error.status >= 500 || !navigator.onLine)) return cached.session;
          throw error;
        }
      });
    },
  });
  async function authenticate(path, body) {
    // Pause every tab synchronously before rotating this origin's session cookie.
    const cached = readSession();
    writeSession({ ...cached, expired: true });
    const data = await sessionLock(async () => {
      await finishLogout(apiRequest);
      return apiRequest(path, { method: 'POST', body, schema: authResponseSchema });
    });
    // Never let data from a previous organization survive an account switch.
    await queryClient.cancelQueries();
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'session' });
    queryClient.setQueryData(['session'], data);
    writeSession({ session: data, expired: false, loggedOut: false, pendingLogout: false });
  }
  async function logout() {
    writeSession({ session: null, expired: false, loggedOut: true, pendingLogout: true });
    await queryClient.cancelQueries();
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'session' });
    queryClient.setQueryData(['session'], null);
    if (navigator.onLine) await sessionLock(() => finishLogout(apiRequest)).catch(() => {});
  }
  const identity = session.data ? `${session.data.organization.id}:${session.data.user.id}:${session.data.user.role}` : 'guest';
  return <AuthContext.Provider value={{ session, expired: local.expired, authenticate, logout }}>
    <Fragment key={identity}>{children}</Fragment>
  </AuthContext.Provider>;
}
export function useAuth() { return useContext(AuthContext); }

export function RequireSession() {
  const { session } = useAuth();
  if (session.isPending) return <p className="p-10 text-stone-500">Opening your workspace…</p>;
  if (session.isError) return <div className="mx-auto max-w-lg p-10"><ErrorNotice error={session.error} />
    <button className="button-secondary mt-4" onClick={() => session.refetch()}>Try again</button></div>;
  return session.data ? <Outlet /> : <Navigate to="/login" replace />;
}

export function RequireAdmin() {
  const { session } = useAuth();
  return session.data.user.role === 'admin' ? <Outlet /> : <Navigate to="/assets" replace />;
}
