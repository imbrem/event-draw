import type { VisibleText } from '../model.ts';
import { renderText } from '../text.ts';
import 'katex/dist/katex.min.css';

interface Draft { source: string; saved: string; format: string; saving: boolean; error: string; pending?: Promise<void> }
interface EditorOptions {
  save(pageId: number, format: string, source: string): Promise<void>;
  changed(): void;
  closed(): void;
}
/** Page-keyed drafts and debounced saves; DB revisions/undo stay in the journal. */
export class TextEditor {
  private root: HTMLElement;
  private options: EditorOptions;
  private drafts = new Map<number, Draft>();
  private pageId = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private source: HTMLTextAreaElement;
  private preview: HTMLElement;
  private status: HTMLElement;
  constructor(root: HTMLElement, options: EditorOptions) {
    this.root = root; this.options = options;
    root.innerHTML = '<header class="text-header"><strong>Page text</strong><span id="text-status" role="status"></span><button id="save-text">Save now</button><button id="close-text" aria-label="Close text notes">×</button></header>' +
      '<label class="text-source-label">Markdown · inline math: $…$<textarea id="text-source" aria-label="Markdown note" maxlength="200000" spellcheck="true" placeholder="# Notes\n\nWrite **Markdown** and inline math such as $E = mc^2$."></textarea></label>' +
      '<div id="text-preview" class="markdown-preview" aria-label="Rendered note"></div>';
    this.source = root.querySelector('#text-source')!; this.preview = root.querySelector('#text-preview')!;
    this.status = root.querySelector('#text-status')!;
    root.querySelector<HTMLButtonElement>('#close-text')!.onclick = options.closed;
    root.querySelector<HTMLButtonElement>('#save-text')!.onclick = () => { void this.flush(); };
    this.source.oninput = () => {
      const draft = this.drafts.get(this.pageId)!; draft.source = this.source.value; draft.error = '';
      renderText(draft.format, draft.source, this.preview); this.showStatus();
      clearTimeout(this.timer); this.timer = setTimeout(() => { void this.flush(); }, 600);
      this.options.changed();
    };
  }
  get dirty() { return [...this.drafts.values()].some((d) => d.source !== d.saved || d.saving); }
  recovery() { return [...this.drafts].filter(([, d]) => d.source !== d.saved).map(([pageId, d]) => ({ pageId, format: d.format, source: d.source })); }
  update(pageId: number, text: VisibleText | undefined, disabled: boolean) {
    this.pageId = pageId;
    let draft = this.drafts.get(pageId);
    if (!draft) {
      draft = { source: text?.source ?? '', saved: text?.source ?? '', format: text?.format ?? 'markdown', saving: false, error: '' };
      this.drafts.set(pageId, draft);
    } else if (draft.source === draft.saved && !draft.saving) {
      draft.source = draft.saved = text?.source ?? ''; draft.format = text?.format ?? 'markdown';
    }
    if (this.source.value !== draft.source) { this.source.value = draft.source; renderText(draft.format, draft.source, this.preview); }
    this.source.disabled = disabled || !pageId;
    this.root.querySelector<HTMLButtonElement>('#save-text')!.disabled = disabled || draft.source === draft.saved;
    this.showStatus();
  }
  private showStatus() {
    const draft = this.drafts.get(this.pageId);
    this.status.textContent = draft?.error || (draft?.saving ? 'Saving…' : draft && draft.source !== draft.saved ? 'Unsaved' : 'Saved');
  }
  flush(): Promise<void> {
    clearTimeout(this.timer);
    return this.flushPage(this.pageId);
  }
  /** Include drafts still saving on another page, particularly before export. */
  async flushAll(): Promise<void> {
    clearTimeout(this.timer);
    await Promise.all([...this.drafts.keys()].map((id) => this.flushPage(id)));
  }
  private flushPage(pageId: number): Promise<void> {
    const draft = this.drafts.get(pageId);
    if (!draft) return Promise.resolve();
    if (draft.saving) return draft.pending!;
    if (draft.source === draft.saved) return Promise.resolve();
    draft.pending = this.saveDraft(pageId, draft);
    return draft.pending;
  }
  private async saveDraft(pageId: number, draft: Draft) {
    draft.saving = true; draft.error = ''; this.showStatus();
    try {
      while (draft.source !== draft.saved) {
        const source = draft.source;
        await this.options.save(pageId, draft.format, source); draft.saved = source;
      }
    }
    catch (error) { draft.error = 'Not saved: ' + String(error); }
    finally { draft.saving = false; draft.pending = undefined; this.showStatus(); this.options.changed(); }
  }
  clear() { clearTimeout(this.timer); this.drafts.clear(); this.source.value = ''; this.preview.replaceChildren(); }
  close() { clearTimeout(this.timer); }
}
