import type { ObjectInput, PageObject } from '../model.ts';
import { contentSource, renderContent } from './content-renderers.ts';

interface Draft { input: ObjectInput; source: string; saved: string; saving: boolean; error: string; pending?: Promise<void> }
interface EditorOptions {
  save(input: ObjectInput): Promise<void>;
  create(rendered: boolean): Promise<void>;
  remove(pageId: number, id: number): Promise<boolean>;
  changed(): void;
  closed(): void;
}
export function objectInput(object: PageObject): ObjectInput {
  return { id: object.id, pageId: object.page_id, format: object.format, data: JSON.parse(object.data_json), rendered: Boolean(object.rendered),
    x: object.x, y: object.y, width: object.width, height: object.height, rotation: object.rotation, label: object.label };
}
/** Object-keyed drafts. Page text, linked notes and generated content use the
 * same persistence/renderer path; only placement and format differ.
 */
export class TextEditor {
  private root: HTMLElement;
  private options: EditorOptions;
  private drafts = new Map<number, Draft>();
  private selection = new Map<number, number>();
  private pageId = 0;
  private objectId = 0;
  private changing = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private source: HTMLTextAreaElement;
  private preview: HTMLElement;
  private status: HTMLElement;
  private previewKey = '';
  constructor(root: HTMLElement, options: EditorOptions) {
    this.root = root; this.options = options;
    root.innerHTML = '<header class="text-header"><strong>Page content</strong><span id="text-status" role="status"></span><button id="save-text">Save now</button><button id="close-text" aria-label="Close text notes">×</button></header>' +
      '<div class="object-actions"><button id="add-page-text">Add page text</button><button id="add-linked-note">Add linked note</button></div>' +
      '<label class="object-choice">Object <select id="content-object" aria-label="Content object"></select></label>' +
      '<div class="object-properties"><label>Label <input id="object-label" maxlength="200"></label><label>Format <input id="object-format" list="content-formats" maxlength="100"></label>' +
      '<datalist id="content-formats"><option value="text/markdown"><option value="math/latex"><option value="chart/vega-lite"><option value="math/mathml"></datalist>' +
      '<label><input type="checkbox" id="object-rendered"> Show on page</label>' +
      '<div class="object-placement">' + ['x', 'y', 'width', 'height', 'rotation'].map((key) => '<label>' + (key === 'rotation' ? 'Angle (°)' : key) + '<input id="object-' + key + '" type="number" aria-label="Object ' + key + '" step="any"' + (key === 'width' || key === 'height' ? ' min="0.01"' : '') + '></label>').join('') + '</div></div>' +
      '<label class="text-source-label">Markdown / LaTeX source; other formats use JSON<textarea id="text-source" aria-label="Markdown note" maxlength="200000" spellcheck="true" placeholder="Add page text or a linked note to begin."></textarea></label>' +
      '<div id="text-preview" class="markdown-preview" aria-label="Rendered note"></div><button id="delete-object">Delete object</button>';
    this.source = root.querySelector('#text-source')!; this.preview = root.querySelector('#text-preview')!; this.status = root.querySelector('#text-status')!;
    root.querySelector<HTMLButtonElement>('#close-text')!.onclick = options.closed;
    root.querySelector<HTMLButtonElement>('#save-text')!.onclick = () => { void this.flush(); };
    for (const [id, rendered] of [['add-page-text', true], ['add-linked-note', false]] as const)
      root.querySelector<HTMLButtonElement>('#' + id)!.onclick = () => { void this.changeObject(() => options.create(rendered)); };
    root.querySelector<HTMLSelectElement>('#content-object')!.onchange = (event) => this.select(Number((event.target as HTMLSelectElement).value));
    root.querySelector<HTMLButtonElement>('#delete-object')!.onclick = () => {
      const id = this.objectId, pageId = this.pageId;
      void this.changeObject(async () => {
        if (await options.remove(pageId, id)) this.drafts.delete(id); options.changed();
      });
    };
    this.source.oninput = () => { const draft = this.current(); if (draft) { draft.source = this.source.value; this.changed(draft); } };
    for (const field of root.querySelectorAll<HTMLInputElement>('.object-properties input:not([type="hidden"])')) field.onchange = () => {
      const draft = this.current(); if (!draft) return;
      field.setCustomValidity('');
      const input = draft.input;
      if (field.id === 'object-label') input.label = field.value;
      else if (field.id === 'object-format') input.format = field.value;
      else if (field.id === 'object-rendered') input.rendered = field.checked;
      else { const key = field.id.slice(7) as 'x' | 'y' | 'width' | 'height' | 'rotation'; const n = Number(field.value);
        if (!Number.isFinite(n) || ((key === 'width' || key === 'height') && n <= 0)) { field.setCustomValidity('Enter a valid placement; dimensions must be positive.'); field.reportValidity(); return; }
        input[key] = key === 'rotation' ? n * Math.PI / 180 : n;
      }
      this.changed(draft);
    };
  }
  private current() { return this.drafts.get(this.objectId); }
  private async changeObject(work: () => Promise<void>) {
    if (this.changing) return;
    this.changing = true; this.options.changed();
    try { await this.flush(); if (!this.current()?.error) await work(); }
    finally { this.changing = false; this.options.changed(); }
  }
  private key(draft: Draft) { return JSON.stringify({ ...draft.input, data: null, source: draft.source }); }
  private payload(draft: Draft): ObjectInput {
    return { ...draft.input, data: draft.input.format === 'text/markdown' || draft.input.format === 'math/latex' ? { source: draft.source } : JSON.parse(draft.source) };
  }
  private changed(draft: Draft) {
    draft.error = ''; this.renderPreview(draft); this.showStatus();
    clearTimeout(this.timer); this.timer = setTimeout(() => { void this.flush(); }, 600); this.options.changed();
  }
  private renderPreview(draft: Draft) {
    this.previewKey = JSON.stringify([draft.input.format, draft.source]);
    try { renderContent(draft.input.format, this.payload(draft).data, this.preview); }
    catch (error) { this.preview.textContent = 'Invalid JSON: ' + String(error); }
  }
  get dirty() { return [...this.drafts.values()].some((d) => this.key(d) !== d.saved || d.saving); }
  recovery() { return [...this.drafts.values()].filter((d) => this.key(d) !== d.saved).map((d) => ({ ...d.input, source: d.source })); }
  select(id: number) { void this.flush(); this.selection.set(this.pageId, id); this.objectId = id; this.options.changed(); }
  update(pageId: number, objects: PageObject[], disabled: boolean) {
    this.pageId = pageId;
    const chosen = objects.find((o) => o.id === this.selection.get(pageId)) ?? objects[0];
    this.objectId = chosen?.id ?? 0; this.selection.set(pageId, this.objectId);
    const select = this.root.querySelector<HTMLSelectElement>('#content-object')!;
    select.replaceChildren(...objects.map((o) => new Option((o.rendered ? 'Page ' : 'Note ') + '#' + o.id + ' ' + o.label, String(o.id), false, o.id === this.objectId)));
    let draft = this.current();
    if (chosen && (!draft || (this.key(draft) === draft.saved && !draft.saving))) {
      const data = JSON.parse(chosen.data_json);
      draft = { input: objectInput(chosen), source: chosen.format === 'text/markdown' || chosen.format === 'math/latex' ? contentSource(data) : JSON.stringify(data, null, 2), saved: '', saving: false, error: '' };
      draft.saved = this.key(draft); this.drafts.set(chosen.id, draft);
    }
    if (this.source.value !== (draft?.source ?? '')) this.source.value = draft?.source ?? '';
    if (draft && this.previewKey !== JSON.stringify([draft.input.format, draft.source])) this.renderPreview(draft);
    if (!draft) { this.previewKey = ''; this.preview.replaceChildren(); }
    for (const field of this.root.querySelectorAll<HTMLInputElement>('.object-properties input')) {
      if (field.id === 'object-rendered') field.checked = draft?.input.rendered ?? false;
      else {
        const key = field.id.slice(7) as keyof ObjectInput, value = draft?.input[key];
        if (document.activeElement !== field) field.value = value === undefined ? '' : String(key === 'rotation' ? Number(value) * 180 / Math.PI : value);
      }
    }
    this.root.querySelector<HTMLElement>('.object-placement')!.hidden = !draft?.input.rendered;
    for (const control of this.root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>('input,textarea,select,button')) {
      const always = ['close-text', 'add-page-text', 'add-linked-note'].includes(control.id);
      control.disabled = control.id === 'close-text' ? false : disabled || this.changing || (!always && !draft);
    }
    this.root.querySelector<HTMLButtonElement>('#save-text')!.disabled ||= !draft || this.key(draft) === draft.saved;
    this.showStatus();
  }
  private showStatus() {
    const draft = this.current(); this.status.textContent = draft?.error || (this.changing ? 'Updating object…' : draft?.saving ? 'Saving…' : draft && this.key(draft) !== draft.saved ? 'Unsaved' : 'Saved');
  }
  flush(): Promise<void> { clearTimeout(this.timer); return this.flushObject(this.objectId); }
  async flushAll(): Promise<void> { clearTimeout(this.timer); await Promise.all([...this.drafts.keys()].map((id) => this.flushObject(id))); }
  private flushObject(id: number): Promise<void> {
    const draft = this.drafts.get(id); if (!draft || this.key(draft) === draft.saved) return Promise.resolve();
    if (draft.saving) return draft.pending!;
    draft.pending = this.saveDraft(draft); return draft.pending;
  }
  private async saveDraft(draft: Draft) {
    draft.saving = true; draft.error = ''; this.showStatus();
    try {
      while (this.key(draft) !== draft.saved) { const key = this.key(draft), input = this.payload(draft); await this.options.save(input); draft.saved = key; }
    } catch (error) { draft.error = 'Not saved: ' + String(error); }
    finally { draft.saving = false; draft.pending = undefined; this.showStatus(); this.options.changed(); }
  }
  clear() { clearTimeout(this.timer); this.drafts.clear(); this.selection.clear(); this.objectId = 0; this.source.value = ''; this.preview.replaceChildren(); }
  close() { clearTimeout(this.timer); }
}
