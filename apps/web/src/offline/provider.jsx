import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { liveQuery } from 'dexie';
import { authResponseSchema, inspectionDetailSchema, inspectionsResponseSchema } from '@fieldsync/contracts';
import { useAuth } from '../auth.jsx';
import { apiRequest } from '../api/client.js';
import { OfflineStore } from './store.js';
import { flushOutbox } from './sync.js';
import { uploadBlob } from './evidence.js';
import { expireSession, readSession, sessionEvent, sessionKey, sessionLock } from './session.js';

const OfflineContext = createContext(null);
const empty = { records: [], copies: [], queue: [], files:[] };
export function OfflineProvider({ children }) {
  const { session, expired } = useAuth();
  const user = session.data?.user;
  const store = useMemo(() => user?.role === 'worker' ? new OfflineStore({ organizationId: user.organizationId, userId: user.id }) : null,
    [user?.organizationId, user?.id, user?.role]);
  const [snapshot, setSnapshot] = useState(empty);
  const [error, setError] = useState(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [syncing, setSyncing] = useState(false);
  const wake = useRef(() => {});
  useEffect(() => {
    setSnapshot(empty); setError(null);
    if (!store) return;
    const subscription = liveQuery(() => store.snapshot()).subscribe({ next: setSnapshot, error: setError });
    // Do not close handles while an editor's final transaction is still committing.
    return () => subscription.unsubscribe();
  }, [store]);
  useEffect(() => {
    let stopped = false, running = false, timer, controller;
    function active() {
      const record = readSession();
      return !stopped && navigator.onLine && !record.expired && !record.loggedOut
        && record.session?.user.id === store?.owner.userId && record.session?.organization.id === store?.owner.organizationId;
    }
    const request = (path, options) => apiRequest(path, { ...options, signal: controller.signal });
    async function run() {
      setOnline(navigator.onLine);
      if (running || !store || !active()) return;
      running = true; controller = new AbortController();
      try {
        if (!navigator.locks) throw new Error('Web Locks are required for safe multi-tab sync. Local work is retained.');
        await navigator.locks.request(`${store.name}:sync`, { ifAvailable: true }, async (lock) => {
          if (!lock || !active()) return;
          setSyncing(true);
          await sessionLock(async () => {
            if (!active()) return;
            await flushOutbox({ store, request, active, onExpired: expireSession,upload:(descriptor,blob)=>uploadBlob(descriptor,blob,controller.signal) });
            if (!active()) return;
            // Revalidate identity even when the queue was empty before pulling cached data.
            const identity = await request('/auth/me', { schema: authResponseSchema });
            if (!active() || identity.user.id !== store.owner.userId || identity.organization.id !== store.owner.organizationId) return;
            const list = await request('/inspections?status=all', { schema: inspectionsResponseSchema });
            for (const inspection of list.inspections) { if (!active()) return; await store.cache(inspection); }
            const known = await store.snapshot();
            const ids = new Set(list.inspections.map((row) => row.id));
            for (const row of known.records) if (!ids.has(row.id)) await store.unavailable(row.id);
          });
        });
        if (!stopped) setError(null);
      } catch (failure) {
        if (failure.status === 401) expireSession();
        else if (!stopped && active()) setError(failure);
      } finally { running = false; if (!stopped) setSyncing(false); }
    }
    function schedule() { clearTimeout(timer); timer = setTimeout(run, 800); }
    function changed(event) {
      if (event.type === 'storage' && event.key !== sessionKey) return;
      if (!active()) controller?.abort(); else schedule();
    }
    wake.current = schedule;
    const interval = setInterval(run, 15000);
    window.addEventListener('online', run); window.addEventListener('offline', run); window.addEventListener('focus', run);
    window.addEventListener(sessionEvent, changed); window.addEventListener('storage', changed);
    run();
    return () => {
      stopped = true; controller?.abort(); clearTimeout(timer); clearInterval(interval);
      window.removeEventListener('online', run); window.removeEventListener('offline', run); window.removeEventListener('focus', run);
      window.removeEventListener(sessionEvent, changed); window.removeEventListener('storage', changed);
    };
  }, [store, expired]);
  async function refresh(id) {
    if (!store || !navigator.onLine || expired) return;
    return sessionLock(async () => {
      const record = readSession();
      if (record.expired || record.loggedOut || record.session?.user.id !== store.owner.userId) return;
      try {
        const identity = await apiRequest('/auth/me', { schema: authResponseSchema });
        if (identity.user.id !== store.owner.userId || identity.organization.id !== store.owner.organizationId) return;
        const detail = await apiRequest(`/inspections/${encodeURIComponent(id)}`, { schema: inspectionDetailSchema });
        await store.cache(detail.inspection, detail); return detail.inspection;
      } catch (failure) {
        if (failure.status === 404 || failure.status === 403) await store.unavailable(id);
        else if (failure.status === 401) expireSession();
        else if (navigator.onLine || failure.status) setError(failure);
      }
    });
  }
  const conflicts = snapshot.queue.filter((entry) => ['conflict', 'blocked'].includes(entry.status)).length;
  const status = conflicts ? 'Conflict' : !online ? 'Offline' : syncing ? 'Syncing' : 'Online';
  return <OfflineContext.Provider value={{ store, snapshot, error, status, online, syncing, conflicts, refresh, wake: () => wake.current() }}>{children}</OfflineContext.Provider>;
}
export function useOffline() { return useContext(OfflineContext); }
