import { offlineShell } from './scripts/offline-shell.ts';
import { defineConfig } from 'vite';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

// Keep PDF.js fonts/decoders local in both dev and static production builds.
const pdfRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
const pdfAssets = new Map<string, string>();
for (const directory of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  for (const file of readdirSync(join(pdfRoot, directory))) {
    pdfAssets.set('/' + directory + '/' + file, join(pdfRoot, directory, file));
  }
}

export default defineConfig({
  // Pages supplies its actual base path; workers, WASM and PDF assets follow it.
  base: process.env.VITE_BASE_PATH ?? '/',
  plugins: [offlineShell(), {
    name: 'local-pdf-assets',
    configureServer(server) {
      server.middlewares.use('/pdf-assets', (request, response, next) => {
        const path = pdfAssets.get((request.url ?? '').split('?')[0]);
        if (!path) return next();
        response.setHeader('Content-Type', path.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
        response.end(readFileSync(path));
      });
    },
    generateBundle() {
      for (const [name, path] of pdfAssets) this.emitFile({ type: 'asset', fileName: 'pdf-assets' + name, source: readFileSync(path) });
    },
  }],
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  worker: { format: 'es' },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
});
