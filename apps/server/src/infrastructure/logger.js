import pino from 'pino';

export function createLogger(level = 'info') {
  return pino({
    name: 'fieldsync-api',
    level,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]',
        'password', 'token', 'secret', 'credentials', 'config'],
      censor: '[REDACTED]',
    },
  });
}
