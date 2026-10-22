import { PluginRegistry } from '../plugins.ts';
import { renderText } from '../text.ts';
import katex from 'katex';
import 'katex/dist/katex.min.css';

export type ContentRenderer = (data: unknown, root: HTMLElement) => void | Promise<void>;
/** Trusted host adapters keyed by content format, shared by page and sidebar.
 * Unknown formats remain inspectable, without executing document-supplied code.
 */
export const contentRenderers = new PluginRegistry<ContentRenderer>();
export function contentSource(data: unknown): string {
  return typeof data === 'object' && data !== null && 'source' in data && typeof data.source === 'string'
    ? data.source
    : JSON.stringify(data, null, 2);
}
contentRenderers.set('text/markdown', (data, root) => renderText('markdown', contentSource(data), root));
contentRenderers.set('text/plain', (data, root) => {
  const text = document.createElement('div'); text.className = 'plain-text'; text.textContent = contentSource(data);
  root.replaceChildren(text);
});
contentRenderers.set('math/latex', (data, root) => {
  root.innerHTML = katex.renderToString(contentSource(data), {
    displayMode: true,
    throwOnError: false,
    trust: false,
    maxExpand: 1000,
    maxSize: 20,
  });
});
contentRenderers.set('image/svg+xml', async (data, root) => {
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(contentSource(data));
  img.alt = 'SVG drawing';
  root.replaceChildren(img);
  await img.decode();
});
export function registerAssetRenderer(load: (hash: string, mediaType: string) => Promise<HTMLImageElement>) {
  contentRenderers.set('image/asset', (data, root) => {
    if (!data || typeof data !== 'object' || !('hash' in data) || typeof data.hash !== 'string')
      throw new Error('Missing content ID');
    root.textContent = 'Loading image…';
    return load(data.hash, 'mediaType' in data ? String(data.mediaType) : '').then((image) => {
      root.replaceChildren(image);
    });
  });
}
export function renderContent(format: string, data: unknown, root: HTMLElement) {
  try {
    const renderer = contentRenderers.get(format);
    if (renderer) {
      const result = renderer(data, root);
      return result instanceof Promise
        ? result.catch((error) => {
            root.textContent = 'Renderer failed: ' + String(error);
          })
        : result;
    }
    const pre = document.createElement('pre');
    pre.textContent = format + '\n' + contentSource(data);
    root.replaceChildren(pre);
  } catch (error) {
    root.textContent = 'Renderer failed: ' + String(error);
  }
}
