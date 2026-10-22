import type { ContentId } from './model.ts';
/** Host boundary shared by PDF/image backgrounds and page content. Unknown CID
 * schemes must be verified by the backend before bytes are returned. */
export interface ContentSource {
  read(id: ContentId): Promise<Uint8Array>;
}
export const MAX_CONTENT_BYTES = 200 * 1024 * 1024;
// TODO(covalence): arbitrary CIDs/codecs, including BLAKE3. Verified range reads
// need a chunk/tree layout and proofs; a whole-file digest alone is insufficient.
export async function identifyContent(bytes: Uint8Array): Promise<ContentId> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return 'sha256:' + Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
export async function verifyContent(id: ContentId, bytes: Uint8Array): Promise<void> {
  if (id.startsWith('sha256:') && (await identifyContent(bytes)) !== id)
    throw new Error('Content hash does not match its bytes');
}
