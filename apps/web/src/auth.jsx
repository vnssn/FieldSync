import { createContext, Fragment, useContext } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { authResponseSchema } from '@fieldsync/contracts';
import { apiRequest } from './api/client.js';
import { ErrorNotice } from './components/ui.jsx';

const AuthContext = createContext(null);
export function AuthProvider({ children }) {
  const queryClient = useQueryClient();
  const session = useQuery({
    queryKey: ['session'],
    queryFn: async ({ signal }) => {
      try { return await apiRequest('/auth/me', { schema: authResponseSchema, signal }); }
      catch (error) { if (error.status === 401) return null; throw error; }
    },
  });
  async function authenticate(path, body) {
    const data = await apiRequest(path, { method: 'POST', body, schema: authResponseSchema });
    // Never let data from a previous organization survive an account switch.
    await queryClient.cancelQueries();
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'session' });
    queryClient.setQueryData(['session'], data);
  }
  async function logout() {
    try { await apiRequest('/auth/logout', { method: 'POST', body: {} }); }
    catch (error) { if (error.status !== 401) throw error; }
    await queryClient.cancelQueries();
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'session' });
    queryClient.setQueryData(['session'], null);
  }
  const identity = session.data ? `${session.data.organization.id}:${session.data.user.id}:${session.data.user.role}` : 'guest';
  return <AuthContext.Provider value={{ session, authenticate, logout }}>
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
