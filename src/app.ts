import { captureSession } from './capture.ts';
import { DatabaseClient, type Initialized } from './database.ts';
import { download } from './download.ts';
import { selectionBounds } from './geometry.ts';
import { interactionPolicies, DEFAULT_TOUCH } from './interactions.ts';
import { EMPTY_STATE, measuredSamples, type Document, type Gesture, type Page, type State } from './model.ts';
import { PAGE_PRESETS, PageViews } from './pages.ts';
import { PdfLibrary } from './pdf/library.ts';
import { identifyPdf, MAX_PDF_BYTES, readPdfUrl } from './pdf/source.ts';
import { NotebookCanvas } from './ui/canvas.ts';
import { PageNavigation } from './ui/page-navigation.ts';
import { PageSurface } from './ui/page-surface.ts';
import { NotebookLocation } from './ui/notebook-location.ts';
import { mountShell, element } from './ui/shell.ts';
import { DatabaseViewer } from './ui/viewer.ts';
import { ToolPicker } from './ui/tool-picker.ts';
import { InkControls, PaintControls } from './ui/ink-controls.ts';
import { TextEditor } from './ui/text-editor.ts';
import { PageObjects } from './ui/page-objects.ts';

export function startApp(): () => void {
  mountShell();
  const db = new DatabaseClient(), pdfs = new PdfLibrary(db), session = captureSession();
  const location = new NotebookLocation();
  let state: State = EMPTY_STATE, sessionId = 0, { documentId, pageId } = location.read();
  let ready = false, failed = false, active = false, writes = 0, ownsDatabase = true, resetting = false, importing = false;
  let background: 'ready' | 'loading' | 'error' = 'ready', tab = 'notebook';
  let pending: Gesture[] = [], unsaved: Gesture[] = [], selected = new Set<number>();
  let operations: Promise<void> = Promise.resolve();
  let shownDocument = '';
  const views = new PageViews(), canvas = element<HTMLCanvasElement>('canvas');
  const notice = element('notice'), options = element<HTMLDetailsElement>('options');
  const documentSelect = element<HTMLSelectElement>('document');
  const currentDocument = (): Document | undefined => state.documents.find((d) => d.id === documentId);
  const pages = () => state.pages.filter((p) => p.document_id === documentId);
  const page = (): Page | undefined => pages().find((p) => p.id === pageId);
  const shapes = () => state.shapes.filter((s) => s.page_id === pageId);
  const selectPage = (id: number) => { void textEditor.flush(); selected.clear(); pageId = id; refresh(); };
  const tools = new ToolPicker(element('tool-picker'), () => { selected.clear(); refresh(); });
  const paints = new PaintControls(element('color'), element('width'));
  const inkControls = new InkControls(element('ink-policies'));
  const lassoLabels: Record<string, string> = { 'touch-or-enclose@1': 'Touch or enclose', 'vertices-inside@1': 'All vertices inside' };
  for (const [id] of interactionPolicies.lassos) element<HTMLSelectElement>('lasso-policy').add(new Option(lassoLabels[id] ?? id, id));
  const textEditor = new TextEditor(element('text-panel'), {
    async save(input) {
      await edit(() => db.setObject(input));
      if (failed) throw new Error('Database write failed; export unsaved drafts before resetting.');
    },
    async create(rendered) {
      const targetPage = pageId, previous = new Set(state.objects.map((o) => o.id)), box = view();
      await edit(() => db.setObject({ pageId: targetPage, format: 'text/markdown', data: { source: '' }, rendered,
        x: box.x + box.width * .1, y: box.y + box.height * .1, width: box.width * .6, height: Math.min(240, box.height * .3), rotation: 0, label: rendered ? 'Text' : 'Note' }),
        () => textEditor.select(state.objects.find((o) => !previous.has(o.id))!.id));
    },
    async remove(targetPage, id) { await edit(() => db.deleteObject(targetPage, id)); return !failed; },
    changed: () => refresh(), closed: () => showText(false),
  });
  const navigation = new PageNavigation(element('page-navigation'), selectPage);
  const viewer = new DatabaseViewer(element('viewer-panel'), db);
  const surface = new PageSurface(element('page-viewport'), element('paper'), element('pdf-canvas'), pdfs, (status, value) => {
    background = status;
    if (value) error(value);
    refresh();
  });
  const view = () => {
    const box = views.get(page());
    return page()?.kind === 'whiteboard' ? { ...box, height: box.width / surface.aspect } : box;
  };
  const pageObjects = new PageObjects(element('page-objects'), element('paper'), (id) => textEditor.select(id), (ids) => {
    element('tool-picker').querySelector<HTMLButtonElement>('[data-tool="lasso"]')!.click();
    selected = new Set(ids); refresh();
  });
  const gesture = (tool: Gesture['tool']): Gesture => ({ pageId, tool,
    style: paints.style(tool === 'move-selection' ? 'lasso' : tool),
    policy: inkControls.value,
    interaction: tool === 'restyle' ? DEFAULT_TOUCH : { id: element<HTMLSelectElement>('lasso-policy').value, options: {} },
    radius: Number(element<HTMLInputElement>('radius').value), cancelled: false, data: { deliveries: [] } });
  const notebook = new NotebookCanvas(canvas, {
    canStart: () => ready && !failed && !resetting && !importing && background === 'ready' && (tools.value === 'pen' || tools.value === 'highlighter' || writes === 0),
    touchEnabled: () => element<HTMLInputElement>('touch').checked,
    tool: () => tools.value, gesture, view,
    scene: () => ({ shapes: shapes(), pending: pending.filter((g) => g.pageId === pageId), view: view(),
      tool: tools.value, selected: [...selected], radius: Number(element<HTMLInputElement>('radius').value) }),
    moveTargets(point) {
      const bounds = selectionBounds(shapes().filter((s) => selected.has(s.id)));
      const pad = 8 * view().width / canvas.getBoundingClientRect().width;
      return bounds && point.x >= bounds.x - pad && point.x <= bounds.x + bounds.width + pad &&
        point.y >= bounds.y - pad && point.y <= bounds.y + bounds.height + pad ? [...selected] : [];
    },
    onActive(value) { active = value; refresh(); },
    onPan(value) { views.pan(page()!, value); refresh(); },
    onGesture(input) {
      unsaved.push(input); if (!input.cancelled) pending.push(input);
      const last = input.data.deliveries.at(-1)!;
      element('sample-info').textContent = JSON.stringify({ input: last.reported.pointerType,
        measuredSamples: measuredSamples(input.data).length,
        predictedSamples: input.data.deliveries.reduce((n, d) => n + d.predicted.length, 0),
        lastReported: last.reported, status: input.cancelled ? 'cancelled' : 'complete' }, null, 2);
      edit(() => db.gesture(input, sessionId), () => {
        if (!input.cancelled && input.tool === 'lasso') selected = new Set(interactionPolicies.select(shapes(), measuredSamples(input.data), input.interaction));
        pending = pending.filter((item) => item !== input); unsaved = unsaved.filter((item) => item !== input);
      });
    },
  });
  function error(value: unknown) {
    notice.hidden = false; notice.className = 'error';
    notice.textContent = value instanceof Error ? value.message : String(value);
  }
  function chooseDocument(id: number) {
    void textEditor.flush();
    documentId = id; pageId = pages()[0]?.id ?? 0; selected.clear(); refresh();
  }
  function refresh() {
    selected = new Set([...selected].filter((id) => shapes().some((s) => s.id === id)));
    const busy = !ready || failed || active || writes > 0 || resetting || importing;
    const board = page()?.kind === 'whiteboard', pdf = Boolean(currentDocument()?.pdf_hash);
    tools.update({ disabled: busy, whiteboard: board });
    paints.select(tools.value);
    inkControls.update(busy);
    textEditor.update(pageId, state.objects.filter((o) => o.page_id === pageId), !ready || failed || active || resetting || importing);
    navigation.update(pages(), pageId, busy);
    for (const id of ['document', 'document-name', 'rename-document', 'new-document', 'pdf-file', 'pdf-url', 'import-url',
      'page-size', 'add-page', 'color', 'width', 'radius', 'touch', 'zoom-in', 'zoom-out', 'home-view', 'toggle-text', 'lasso-policy']) {
      (element(id) as HTMLInputElement | HTMLButtonElement | HTMLSelectElement).disabled = busy;
    }
    element<HTMLButtonElement>('undo').disabled = busy || !state.undoablePages.includes(pageId);
    element<HTMLButtonElement>('clear').disabled = busy || !shapes().length;
    element<HTMLButtonElement>('delete-page').disabled = busy || pdf || pages().length <= 1;
    element<HTMLButtonElement>('page-earlier').disabled = busy || pdf || page()?.page_number === 1;
    element<HTMLButtonElement>('page-later').disabled = busy || pdf || page()?.page_number === pages().length;
    for (const id of ['delete-selection', 'deselect', 'apply-processing']) element<HTMLButtonElement>(id).disabled = busy || !selected.size;
    element('selection-controls').hidden = tools.value !== 'lasso';
    element('selection-count').textContent = selected.size + ' selected';
    element<HTMLButtonElement>('export-full').disabled = !ready || active || writes > 0 || importing;
    element<HTMLButtonElement>('export-visible').disabled = busy;
    for (const id of ['reset-settings', 'reset-local', 'export-existing']) {
      element<HTMLButtonElement>(id).disabled = active || writes > 0 || !ownsDatabase || resetting || importing;
    }
    element('recover').hidden = !failed || (!unsaved.length && !textEditor.dirty);
    element('counts').textContent = shapes().length + ' visible · ' + state.rawCount + ' raw strokes · ' + state.eventCount + ' events';
    element('save-state').textContent = failed ? 'Could not save' : !ready ? 'Not open' : importing ? 'Importing PDF…' :
      active ? 'Drawing' : writes ? 'Saving…' : textEditor.dirty ? 'Unsaved text' : background === 'loading' ? 'Loading PDF…' : background === 'error' ? 'PDF unavailable' : 'Saved';
    documentSelect.replaceChildren(...state.documents.map((d) => new Option(d.name || 'Blank notes', String(d.id), false, d.id === documentId)));
    const documentKey = documentId + ':' + currentDocument()?.name;
    if (documentKey !== shownDocument) {
      shownDocument = documentKey;
      element<HTMLInputElement>('document-name').value = currentDocument()?.name ?? '';
    }
    element('document-hash').textContent = currentDocument()?.pdf_hash ?? 'Blank document · no PDF';
    element('page-heading').textContent = (currentDocument()?.name ?? '') + '/' + (page()?.page_number ?? 1);
    element('blank-page-controls').hidden = pdf;
    if (ready) location.write(documentId, pageId);
    element('board-controls').hidden = !board;
    const painting = ['pen', 'highlighter', 'restyle'].includes(tools.value);
    element('color-control').hidden = !painting;
    element('width-control').hidden = !painting;
    element('eraser-control').hidden = !tools.value.startsWith('erase') && tools.value !== 'restyle';
    const box = view(); canvas.dataset.viewWidth = String(box.width); canvas.dataset.viewHeight = String(box.height);
    element('view-position').textContent = 'x ' + Math.round(box.x) + ', y ' + Math.round(box.y) + ' · ' + Math.round(100000 / box.width) + '%';
    surface.update(page(), currentDocument()); notebook.repaint();
    pageObjects.update(state.objects.filter((o) => o.page_id === pageId), element<HTMLInputElement>('show-boxes').checked ? state.boxes.filter((b) => b.page_id === pageId) : [], box,
      !element('text-panel').hidden && !busy, tools.value === 'lasso' && !busy);
  }
  function edit(work: () => Promise<State>, after?: () => void, fatal = true) {
    writes++; refresh();
    operations = operations.then(async () => {
      try {
        if (failed) return;
        state = await work(); after?.();
        if (!page()) pageId = pages()[0]?.id ?? 0;
        if (tab !== 'notebook') void viewer.refresh();
      } catch (value) { if (fatal) failed = true; error(value); }
      finally { writes--; refresh(); }
    });
    return operations;
  }
  async function open(result: Initialized) {
    if (result.mode === 'blocked') {
      ownsDatabase = false; notice.hidden = false;
      notice.textContent = 'Notebook already open in another tab. Close that tab, then reload this one.';
      element('storage').textContent = 'Open in another tab'; element('recovery-actions').hidden = true;
    } else {
      state = result.state; sessionId = result.sessionId; ready = true; failed = false;
      documentId = state.documents.some((d) => d.id === documentId) ? documentId : state.documents[0].id;
      pageId = pages().some((p) => p.id === pageId) ? pageId : pages()[0].id;
      pending = []; unsaved = []; notice.hidden = result.mode === 'persistent'; notice.className = '';
      element('storage').textContent = result.mode === 'persistent' ? 'Stored on this device' : 'Session only · export to keep';
      if (result.mode === 'temporary') notice.textContent = 'Persistent browser storage is unavailable. Export before closing. Use HTTPS or localhost.';
      element('recovery-actions').hidden = true;
    }
    refresh();
  }
  async function reset() {
    if (!ownsDatabase || active || writes || resetting || importing) return;
    if (!confirm('Delete all local documents, PDFs, pages, captures and edit history? Export anything you want to keep first.')) return;
    resetting = true; refresh();
    try {
      await operations; textEditor.clear(); views.clear(); selected.clear(); documentId = 1; pageId = 1;
      await open(await db.reset(session)); setTab('notebook');
    } catch (value) { error(value); }
    finally { resetting = false; refresh(); }
  }
  function setTab(name: string) {
    if (active) return;
    viewer.hide();
    void textEditor.flush();
    tab = name; options.open = false;
    document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === name)));
    element('notebook-panel').hidden = name !== 'notebook'; element('viewer-panel').hidden = name === 'notebook';
    element('return-notebook').hidden = name === 'notebook';
    if (name !== 'notebook') {
      if (ready) void viewer.show(name === 'raw');
      else element('viewer-panel').textContent = 'Open or reset the local notebook to inspect its database.';
    }
    notebook.repaint();
  }
  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => b.onclick = () => setTab(b.dataset.tab!));
  element('return-notebook').onclick = () => setTab('notebook');
  function showText(open: boolean) {
    element('text-panel').hidden = !open;
    element('toggle-text').setAttribute('aria-expanded', String(open));
    if (!open) void textEditor.flush();
    refresh();
  }
  element('toggle-text').onclick = () => showText(Boolean(element('text-panel').hidden));
  element('show-boxes').onchange = () => refresh();
  documentSelect.onchange = () => chooseDocument(Number(documentSelect.value));
  element('rename-document').onclick = () => {
    const name = element<HTMLInputElement>('document-name').value;
    void edit(() => db.renameDocument(documentId, name), undefined, false);
  };
  element('new-document').onclick = () => { void edit(() => db.createDocument('Notes'), () => chooseDocument(state.documents.at(-1)!.id)); };
  element('undo').onclick = () => {
    const targetPage = pageId;
    void textEditor.flush().then(() => edit(() => db.undo(targetPage)));
  };
  element('clear').onclick = () => { void edit(() => db.clear(pageId)); };
  element('delete-selection').onclick = () => { void edit(() => db.deleteShapes(pageId, [...selected]), () => selected.clear()); };
  element('apply-processing').onclick = () => {
    const policy = inkControls.value, ids = [...selected], targetPage = pageId;
    void edit(() => db.reprocess(targetPage, ids, policy), () => selected.clear());
  };
  element('deselect').onclick = () => { selected.clear(); refresh(); };
  element('add-page').onclick = () => {
    const { width, height } = PAGE_PRESETS.find((p) => p.id === element<HTMLSelectElement>('page-size').value)!;
    const before = new Set(state.pages.map((p) => p.id));
    void edit(() => db.addPage(documentId, pageId, width, height), () => selectPage(state.pages.find((p) => !before.has(p.id))!.id));
  };
  for (const [id, action] of [['page-earlier', 'earlier'], ['page-later', 'later'], ['delete-page', 'delete']] as const) {
    element(id).onclick = () => {
      if (action === 'delete' && !confirm('Delete this blank page and its annotations from the current document? This page operation has no Undo yet. Full-history export retains the records.')) return;
      void textEditor.flush();
      void edit(() => db.changePage(pageId, action));
    };
  }
  async function importPdf(load: () => Promise<{ bytes: Uint8Array; name: string }>) {
    if (!ready || importing || active || writes) return;
    importing = true; notice.hidden = true; refresh();
    try {
      await textEditor.flushAll(); await operations;
      if (failed) throw new Error('Save text drafts before importing a PDF.');
      const { bytes, name } = await load();
      if (bytes.length > MAX_PDF_BYTES) throw new Error('PDF exceeds the 200 MiB import limit');
      const hash = await identifyPdf(bytes), pdfPages = await pdfs.inspect(bytes);
      state = await db.importPdf({ hash, name, bytes, pages: pdfPages });
      chooseDocument(state.documents.find((d) => d.pdf_hash === hash)!.id);
      options.open = false; setTab('notebook');
    } catch (value) { error(value); }
    finally { importing = false; refresh(); }
  }
  element<HTMLInputElement>('pdf-file').onchange = () => {
    const input = element<HTMLInputElement>('pdf-file'), file = input.files?.[0];
    if (file) void importPdf(async () => {
      if (file.size > MAX_PDF_BYTES) throw new Error('PDF exceeds the 200 MiB import limit');
      return { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name.replace(/\.pdf$/i, '') };
    });
    input.value = '';
  };
  element('pdf-url-form').onsubmit = (event) => { event.preventDefault(); void importPdf(() => readPdfUrl(element<HTMLInputElement>('pdf-url').value)); };
  async function exportDb(kind: 'full' | 'visible') {
    try { await textEditor.flushAll(); await operations; download(await db.export(kind), 'application/vnd.sqlite3', 'event-draw-' + kind + '.sqlite3'); document.querySelector<HTMLDetailsElement>('.export-menu')!.open = false;
      if (textEditor.dirty) error('SQLite contains saved records only. Use Export unsaved input to keep the text drafts too.');
    }
    catch (value) { error(value); }
  }
  element('export-full').onclick = () => { void exportDb('full'); };
  element('export-visible').onclick = () => { void exportDb('visible'); };
  element('export-existing').onclick = () => { void exportDb('full'); };
  element('reset-local').onclick = () => { void reset(); };
  element('reset-settings').onclick = () => { void reset(); };
  element('recover').onclick = () => download(JSON.stringify({ session, gestures: unsaved, textDrafts: textEditor.recovery() }, null, 2), 'application/json', 'event-draw-unsaved.json');
  function zoom(factor: number) { if (page()?.kind === 'whiteboard') views.zoom(page()!, 1 / factor); else surface.scale(factor); refresh(); }
  element('zoom-in').onclick = () => zoom(1.25);
  element('zoom-out').onclick = () => zoom(0.8);
  element('home-view').onclick = () => { views.reset(pageId); surface.reset(); refresh(); };
  const unload = (event: BeforeUnloadEvent) => { if (active || writes || unsaved.length || importing || textEditor.dirty) event.preventDefault(); };
  window.addEventListener('beforeunload', unload);
  void db.init(session).then(open).catch((value) => {
    failed = true; error(value); element('storage').textContent = 'Notebook could not open'; element('recovery-actions').hidden = false; refresh();
  });
  refresh();
  return () => { textEditor.close(); pageObjects.close(); viewer.hide(); surface.close(); notebook.close(); pdfs.close(); db.close(); window.removeEventListener('beforeunload', unload); };
}
