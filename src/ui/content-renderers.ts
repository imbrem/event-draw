import { PluginRegistry } from '../plugins.ts';
import { renderText } from '../text.ts';
import katex from 'katex';
import 'katex/dist/katex.min.css';

export type ContentRenderer = (data: unknown, root: HTMLElement) => void;
/** Trusted host adapters keyed by content format, shared by page and sidebar.
 * Unknown formats remain inspectable, without executing document-supplied code.
 */
export const contentRenderers = new PluginRegistry<ContentRenderer>();
export function contentSource(data: unknown): string {
  return typeof data === 'object' && data !== null && 'source' in data && typeof data.source === 'string' ? data.source : JSON.stringify(data, null, 2);
}
contentRenderers.set('text/markdown', (data, root) => renderText('markdown', contentSource(data), root));
contentRenderers.set('math/latex', (data, root) => { root.innerHTML = katex.renderToString(contentSource(data), { displayMode: true, throwOnError: false, trust: false, maxExpand: 1000, maxSize: 20 }); });
export function renderContent(format: string, data: unknown, root: HTMLElement) {
  try {
    const renderer = contentRenderers.get(format);
    if (renderer) { renderer(data, root); return; }
    const pre = document.createElement('pre'); pre.textContent = format + '\n' + contentSource(data); root.replaceChildren(pre);
  } catch (error) { root.textContent = 'Renderer failed: ' + String(error); }
}
