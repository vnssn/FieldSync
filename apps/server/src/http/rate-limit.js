import { createHash } from 'node:crypto';
import { HttpError } from './errors.js';

// A bounded per-process burst guard. PostgreSQL separately enforces the durable
// AI budget across API instances. No Redis outage can disable manual workflows.
export function createRateLimits(env, now = Date.now) {
  const windows = new Map();
  function limit(category, maximum, identity) {
    return (req,res,next) => {
      const time = now();
      for (const [key,value] of windows) if (value.until<=time) windows.delete(key);
      const key = `${category}:${createHash('sha256').update(identity(req)).digest('hex')}`;
      let window = windows.get(key);
      if (!window) {
        if (windows.size>=10000) throw new HttpError(429,'RATE_LIMITED','Too many requests. Try again shortly.');
        window = { count:0,until:time+60000 }; windows.set(key,window);
      }
      if (++window.count>maximum) {
        res.set('Retry-After',String(Math.max(1,Math.ceil((window.until-time)/1000))));
        throw new HttpError(429,'RATE_LIMITED','Too many requests. Try again shortly.');
      }
      next();
    };
  }
  return {
    auth:limit('auth',env.AUTH_RATE_LIMIT ?? 60,(req) => req.ip ?? req.socket.remoteAddress ?? 'unknown'),
    ai:limit('ai',env.AI_RATE_LIMIT ?? 10,(req) => `${req.auth.organizationId}:${req.auth.user.id}`),
  };
}
