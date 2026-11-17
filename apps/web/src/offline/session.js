import { offlineSessionSchema } from '@fieldsync/contracts';

export const sessionKey = 'fieldsync:session';
export const sessionEvent = 'fieldsync-session-change';
const empty = { session: null, expired: false, loggedOut: false, pendingLogout: false };
export function readSession() {
  try { const raw = localStorage.getItem(sessionKey); return raw ? offlineSessionSchema.parse(JSON.parse(raw)) : empty; }
  catch { return { ...empty, loggedOut: true }; }
}
export function writeSession(value) {
  const record = offlineSessionSchema.parse(value);
  const json = JSON.stringify(record);
  if (localStorage.getItem(sessionKey) !== json) {
    localStorage.setItem(sessionKey, json);
    window.dispatchEvent(new Event(sessionEvent));
  }
  return record;
}
export function expireSession() {
  const record = readSession();
  if (record.session && !record.expired) writeSession({ ...record, expired: true });
}
export function sessionLock(callback) {
  // Account switching cannot rotate the cookie between a sync identity check and dispatch.
  if (!navigator.locks) throw new Error('This browser cannot safely synchronize. Use a browser with Web Locks support.');
  return navigator.locks.request('fieldsync-session', callback);
}
export async function finishLogout(request) {
  const record = readSession();
  if (!record.pendingLogout) return;
  try { await request('/auth/logout', { method: 'POST', body: {} }); }
  catch (error) { if (error.status !== 401) throw error; }
  writeSession({ ...record, pendingLogout: false });
}
