export function redisConnection(env) {
  if (!env.REDIS_URL) return { host:env.REDIS_HOST,port:env.REDIS_PORT,password:env.REDIS_PASSWORD };
  const url = new URL(env.REDIS_URL);
  return { host:url.hostname,port:Number(url.port || 6379),
    username:url.username ? decodeURIComponent(url.username):undefined,
    password:url.password ? decodeURIComponent(url.password):undefined,
    db:Number(url.pathname.slice(1) || 0), ...(url.protocol==='rediss:' ? { tls:{ rejectUnauthorized:true } }:{}) };
}
