import MarkdownIt from 'markdown-it';
import katex from 'katex';

/** Trusted renderer plugins; source strings never contain executable plugins.
 * Register Typst/LaTeX adapters here later without changing the source model.
 */
export const textRenderers = new Map<string, (source: string) => string>();
const markdown = new MarkdownIt({ html: false, breaks: true, maxNesting: 32 });
// Keep text notes self-contained; remote images can become explicit assets later.
markdown.disable('image');
markdown.inline.ruler.before('escape', 'inline_math', (state, silent) => {
  if (state.src[state.pos] !== '$' || state.src[state.pos + 1] === '$') return false;
  let end = state.pos + 1;
  for (; end < state.posMax; end++) {
    if (state.src[end] === '\n') return false;
    if (state.src[end] === '\\') { end++; continue; }
    if (state.src[end] === '$') break;
  }
  if (end >= state.posMax || end === state.pos + 1) return false;
  if (!silent) { const token = state.push('inline_math', 'math', 0); token.content = state.src.slice(state.pos + 1, end); }
  state.pos = end + 1; return true;
});
markdown.renderer.rules.inline_math = (tokens, index) => katex.renderToString(tokens[index].content, {
  throwOnError: false, trust: false, maxExpand: 1000, maxSize: 20, strict: 'ignore',
});
const defaultLink = markdown.renderer.rules.link_open;
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index].attrSet('target', '_blank'); tokens[index].attrSet('rel', 'noopener noreferrer');
  return defaultLink ? defaultLink(tokens, index, options, env, self) : self.renderToken(tokens, index, options);
};
textRenderers.set('markdown', (source) => markdown.render(source));
export function renderText(format: string, source: string, root: HTMLElement) {
  const renderer = textRenderers.get(format);
  if (renderer) root.innerHTML = renderer(source);
  else { const pre = document.createElement('pre'); pre.textContent = source; root.replaceChildren(pre); }
}
