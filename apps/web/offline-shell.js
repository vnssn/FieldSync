import { createHash } from 'node:crypto';

// Cache only the application shell. Auth/API data belongs in tenant-scoped Dexie.
export function offlineShell() {
  return {
    name: 'fieldsync-offline-shell', apply: 'build',
    generateBundle(_options, bundle) {
      const files = ['/', '/favicon.svg', ...Object.keys(bundle).filter((name) => /\.(js|css)$/.test(name)).map((name) => `/${name}`)];
      const version = createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 16);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: `
const cacheName = 'fieldsync-shell-${version}';
const files = ${JSON.stringify(files)};
self.addEventListener('install', event => event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(files)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('fieldsync-shell-') && key !== cacheName).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.open(cacheName).then(cache => cache.match('/'))));
  } else if (files.includes(url.pathname)) {
    event.respondWith(caches.open(cacheName).then(cache => cache.match(url.pathname)).then(cached => cached || fetch(event.request)));
  }
});
` });
    },
  };
}
