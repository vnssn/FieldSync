import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

export const SESSION_COOKIE = 'fieldsync_sid';
const sessionTokenSchema = z.string().regex(/^[a-f0-9]{64}$/);

export function readSessionToken(request) {
  const cookies = (request.headers.cookie ?? '').split(';').map((part) => part.trim());
  const matches = cookies.filter((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (matches.length !== 1) return null;
  const parsed = sessionTokenSchema.safeParse(matches[0].slice(SESSION_COOKIE.length + 1));
  return parsed.success ? parsed.data : null;
}

export function sessionId(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function newSession(env, user) {
  const token = randomBytes(32).toString('hex');
  return {
    token, id: sessionId(token), organizationId: user.organizationId, userId: user.id,
    expiresAt: new Date(Date.now() + env.SESSION_TTL_HOURS * 3600000),
  };
}

export function cookieOptions(env) {
  return {
    httpOnly: true, sameSite: 'lax', path: '/',
    secure: env.NODE_ENV === 'production' || new URL(env.APP_ORIGIN).protocol === 'https:',
  };
}

export function setSessionCookie(response, env, session) {
  response.cookie(SESSION_COOKIE, session.token, { ...cookieOptions(env), expires: session.expiresAt });
}

export function clearSessionCookie(response, env) {
  response.clearCookie(SESSION_COOKIE, cookieOptions(env));
}
