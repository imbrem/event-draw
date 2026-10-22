import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

/** Precache this build's static shell only. Notebooks belong to the storage host. */
export function offlineShell(): Plugin {
  return {
    name: 'offline-shell',
    apply: 'build',
    writeBundle(options) {
      const directory = options.dir!;
      const assets = readdirSync(directory, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => join(e.parentPath, e.name).slice(directory.length + 1))
        .filter((path) => path !== 'sw.js' && !path.startsWith('core/'))
        .sort();
      const hash = createHash('sha256');
      for (const path of assets) hash.update(path).update(readFileSync(join(directory, path)));
      const version = hash.digest('hex').slice(0, 20);
      writeFileSync(
        join(directory, 'sw.js'),
        `
const cacheName = 'event-draw-shell-' + new URL(self.registration.scope).pathname + '-${version}';
const urls = ${JSON.stringify(assets)}.map(path => new URL(path, self.registration.scope).href);
const known = new Set(urls);
self.addEventListener('install', event => event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(urls))));
self.addEventListener('activate', event => event.waitUntil((async () => {
  const prefix = 'event-draw-shell-' + new URL(self.registration.scope).pathname + '-';
  for (const key of await caches.keys()) if (key.startsWith(prefix) && key !== cacheName) await caches.delete(key);
  await self.clients.claim();
})()));
self.addEventListener('message', event => { if (event.data === 'activate-update') self.skipWaiting(); });
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  const navigation = event.request.mode === 'navigate' && url.origin === self.location.origin && url.pathname.startsWith(new URL(self.registration.scope).pathname);
  if (!navigation && !known.has(url.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    // Module requests carry Origin; the precache fetch may not. These are known static files only.
    return await cache.match(navigation ? new URL('index.html', self.registration.scope).href : url.href, { ignoreVary: true }) || fetch(event.request);
  })());
});
`,
      );
    },
  };
}
