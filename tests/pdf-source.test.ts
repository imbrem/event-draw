import assert from 'node:assert/strict';
import { test } from 'node:test';
import { identifyPdf, verifyPdf, readPdfUrl, MAX_PDF_BYTES, type PdfSource } from '../src/pdf/source.ts';

test('content IDs are deterministic; readers can be replaced without SQLite', async () => {
  const bytes = new TextEncoder().encode('abc');
  const id = await identifyPdf(bytes);
  assert.equal(id, 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const source: PdfSource = { async read(requested) { assert.equal(requested, id); return bytes; } };
  await verifyPdf(id, await source.read(id));
  await assert.rejects(verifyPdf(id, new Uint8Array([1])), /does not match/);
  // Other CID verification belongs to the future CAS backend.
  await verifyPdf('opaque:backend-verified-id', bytes);
});

test('URL imports preserve bytes and reject HTTP, CORS and size failures', async (t) => {
  const bytes = new Uint8Array([0, 128, 255]);
  let response = new Response(bytes), requested = '';
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    requested = url.href; assert.equal(init.credentials, 'omit'); return response;
  });
  assert.deepEqual(await readPdfUrl('https://example.com/a%20paper.pdf?download=1'), { bytes, name: 'a paper' });
  assert.equal(requested, 'https://example.com/a%20paper.pdf?download=1');
  await assert.rejects(readPdfUrl('file:///paper.pdf'), /HTTP or HTTPS/);
  response = new Response(null, { status: 404 });
  await assert.rejects(readPdfUrl('https://example.com'), /HTTP 404/);
  response = new Response(bytes, { headers: { 'content-length': String(MAX_PDF_BYTES + 1) } });
  await assert.rejects(readPdfUrl('https://example.com'), /200 MiB/);
  // No content-length: enforce the actual streamed length too.
  response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_PDF_BYTES + 1)); } }));
  await assert.rejects(readPdfUrl('https://example.com'), /200 MiB/);
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('network'); });
  await assert.rejects(readPdfUrl('https://example.com'), /CORS/);
});
