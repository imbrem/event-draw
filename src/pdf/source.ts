export {
  identifyContent as identifyPdf,
  verifyContent as verifyPdf,
  MAX_CONTENT_BYTES as MAX_PDF_BYTES,
} from '../content.ts';
export type { ContentSource as PdfSource } from '../content.ts';
import { MAX_CONTENT_BYTES as MAX_PDF_BYTES } from '../content.ts';

export async function readPdfUrl(input: string): Promise<{ bytes: Uint8Array; name: string }> {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an HTTP or HTTPS PDF URL');
  let response: Response;
  try {
    response = await fetch(url, { credentials: 'omit' });
  } catch {
    throw new Error(
      'Could not fetch this PDF. The server must allow cross-origin requests (CORS). You can also download it and open the file.',
    );
  }
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
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let file = url.pathname.split('/').at(-1) || 'PDF';
  try {
    file = decodeURIComponent(file);
  } catch {
    /* A URL name is only a suggestion. */
  }
  return { bytes, name: file.replace(/\.pdf$/i, '') };
}
