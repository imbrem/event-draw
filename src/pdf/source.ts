import type { ContentId } from '../model.ts';

/** Replace this adapter to read from covalence, a remote CAS, or another store.
 * Unknown CID schemes must be verified by that backend before returning bytes.
 */
export interface PdfSource { read(id: ContentId): Promise<Uint8Array> }

// TODO(covalence): use arbitrary CIDs/codecs and hash algorithms, including BLAKE3.
// Add verified range reads with a chunk/tree layout and proofs; do not assume a
// whole-file digest alone permits independently verified byte-range requests.
export async function identifyPdf(bytes: Uint8Array): Promise<ContentId> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return 'sha256:' + Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
export async function verifyPdf(id: ContentId, bytes: Uint8Array): Promise<void> {
  if (id.startsWith('sha256:') && await identifyPdf(bytes) !== id) throw new Error('PDF content hash does not match its bytes');
}

export const MAX_PDF_BYTES = 200 * 1024 * 1024;
export async function readPdfUrl(input: string): Promise<{ bytes: Uint8Array; name: string }> {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an HTTP or HTTPS PDF URL');
  let response: Response;
  try { response = await fetch(url, { credentials: 'omit' }); }
  catch { throw new Error('Could not fetch this PDF. The server must allow cross-origin requests (CORS). You can also download it and open the file.'); }
  if (!response.ok) throw new Error('PDF download failed: HTTP ' + response.status);
  if (Number(response.headers.get('content-length')) > MAX_PDF_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error('PDF exceeds the 200 MiB import limit');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('PDF response has no body');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_PDF_BYTES) throw new Error('PDF exceeds the 200 MiB import limit');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let file = url.pathname.split('/').at(-1) || 'PDF';
  try { file = decodeURIComponent(file); } catch { /* A URL name is only a suggestion. */ }
  return { bytes, name: file.replace(/\.pdf$/i, '') };
}
