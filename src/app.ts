import { StatusIndicators, defaultIndicators, type StatusIndicator } from './ui/status-indicators.ts';
import { DocumentControls } from './ui/document-controls.ts';
import { FrontendExtensions, type FrontendExtension } from './ui/extensions.ts';
import { EDIT_COMMANDS, type FrontendHost } from './frontend.ts';
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
import { objectInput } from './ui/text-editor.ts';
import { PageSources, inspectImage } from './page-sources.ts';
import { registerAssetRenderer } from './ui/content-renderers.ts';
import { NotebookFiles } from './ui/notebook-files.ts';
import { keyboardShortcuts } from './ui/shortcuts.ts';
import { PageBrowser } from './ui/page-browser.ts';
import { PdfText } from './ui/pdf-text.ts';
import type { ClipboardInk } from './model.ts';

export function startApp(
  config: { extensions?: readonly FrontendExtension[]; indicators?: readonly StatusIndicator[] } = {},
): () => void {
  mountShell();
  const db = new DatabaseClient(),
    pdfs = new PdfLibrary(db),
    session = captureSession();
  const sources = new PageSources(db, pdfs);
  registerAssetRenderer((hash, type) => sources.imageElement(hash, type));
  const indicators = new StatusIndicators(
    element('status-indicators'),
    config.indicators ?? defaultIndicators,
    () => db.diagnostics(),
  );
  let selectedObject = 0;
  let clipboard: ClipboardInk[] = [];
  const location = new NotebookLocation();
  let state: State = EMPTY_STATE,
    sessionId = 0,
    { documentId, pageId } = location.read();
  let ready = false,
    failed = false,
    active = false,
    writes = 0,
    ownsDatabase = true,
    resetting = false,
    importing = false;
  let background: 'ready' | 'loading' | 'error' = 'ready',
    tab = 'notebook';
  let pending: Gesture[] = [],
    unsaved: Gesture[] = [],
    selected = new Set<number>();
  let operations: Promise<void> = Promise.resolve();
  let extensions: FrontendExtensions | undefined;
  const views = new PageViews(),
    canvas = element<HTMLCanvasElement>('canvas');
  const notice = element('notice'),
    options = element<HTMLDetailsElement>('options');
  const documentControls = new DocumentControls(
    (id) => chooseDocument(id),
    (id, name) => {
      void edit(() => db.renameDocument(id, name), undefined, false);
    },
  );
  const currentDocument = (): Document | undefined => state.documents.find((d) => d.id === documentId);
  const pages = () => state.pages.filter((p) => p.document_id === documentId);
  const page = (): Page | undefined => pages().find((p) => p.id === pageId);
  const shapes = () => state.shapes.filter((s) => s.page_id === pageId);
  const selectPage = (id: number) => {
    void textEditor.flush();
    selected.clear();
    pageId = id;
    refresh();
  };
  const tools = new ToolPicker(element('tool-picker'), () => {
    selected.clear();
    selectedObject = 0;
    pageObjects.finishEditing();
    refresh();
  });
  const paints = new PaintControls(element('color'), element('width'), element('color-palette'));
  const inkControls = new InkControls(element('ink-policies'));
  const lassoLabels: Record<string, string> = {
    'touch-or-enclose@1': 'Touch or enclose',
    'vertices-inside@1': 'All vertices inside',
  };
  for (const [id] of interactionPolicies.lassos)
    element<HTMLSelectElement>('lasso-policy').add(new Option(lassoLabels[id] ?? id, id));
  const textEditor = new TextEditor(element('text-panel'), {
    async save(input) {
      await edit(() => db.setObject(input));
      if (failed) throw new Error('Database write failed; export unsaved drafts before resetting.');
    },
    async create(rendered, position) {
      const targetPage = pageId,
        previous = new Set(state.objects.map((o) => o.id)),
        box = view();
      await edit(
        () =>
          db.setObject({
            pageId: targetPage,
            format: 'text/markdown',
            data: { source: '' },
            rendered,
            x: position?.x ?? box.x + box.width * 0.1,
            y: position?.y ?? box.y + box.height * 0.1,
            width: box.width * 0.6,
            height: Math.min(240, box.height * 0.3),
            rotation: 0,
            label: rendered ? 'Text' : 'Note',
          }),
        () => {
          selectedObject = state.objects.find((o) => !previous.has(o.id))!.id;
          textEditor.select(selectedObject);
        },
      );
    },
    async remove(targetPage, id) {
      await edit(() => db.deleteObject(targetPage, id));
      return !failed;
    },
    changed: () => refresh(),
    closed: () => showText(false),
  });
  const navigation = new PageNavigation(element('page-navigation'), selectPage);
  const viewer = new DatabaseViewer(element('viewer-panel'), db);
  const surface = new PageSurface(
    element('page-viewport'),
    element('paper'),
    element('pdf-canvas'),
    sources,
    (status, value) => {
      background = status;
      if (value) error(value);
      refresh();
    },
  );
  const view = () => {
    const box = views.get(page());
    return page()?.kind === 'whiteboard' ? { ...box, height: box.width / surface.aspect } : box;
  };
  const pageObjects = new PageObjects(
    element('page-objects'),
    element('paper'),
    (id) => {
      selected.clear();
      selectedObject = id;
      textEditor.select(id);
    },
    (ids) => {
      element('tool-picker').querySelector<HTMLButtonElement>('[data-tool="lasso"]')!.click();
      selected = new Set(ids);
      refresh();
    },
    (id, placement) => {
      void textEditor.flushAll().then(() => {
        if (textEditor.dirty) {
          error('Save text drafts before moving objects.');
          return;
        }
        const object = state.objects.find((o) => o.id === id);
        if (object) void edit(() => db.setObject({ ...objectInput(object), ...placement }), undefined, false);
      });
    },
    (id, root, done) => textEditor.openInline(id, root, done),
  );
  const pdfText = new PdfText(element('pdf-text'), pdfs);
  const browser = new PageBrowser(element('page-browser'), sources, pdfs, (id) => {
    const target = state.pages.find((p) => p.id === id);
    if (target) {
      documentId = target.document_id;
      selectPage(id);
    }
  });
  const gesture = (tool: Gesture['tool']): Gesture => ({
    pageId,
    tool,
    style: paints.style(tool === 'move-selection' ? 'lasso' : tool),
    policy: inkControls.value,
    interaction:
      tool === 'restyle'
        ? DEFAULT_TOUCH
        : { id: element<HTMLSelectElement>('lasso-policy').value, options: {} },
    radius: Number(element<HTMLInputElement>('radius').value),
    cancelled: false,
    data: { deliveries: [] },
  });
  const notebook = new NotebookCanvas(canvas, {
    canStart: () =>
      ready &&
      !failed &&
      !resetting &&
      !importing &&
      background !== 'loading' &&
      (tools.value === 'pen' || tools.value === 'highlighter' || writes === 0),
    touchEnabled: () => element<HTMLInputElement>('touch').checked,
    tool: () => tools.value,
    onText: (position) => {
      void textEditor.create(true, position).then(() => {
        if (selectedObject) pageObjects.edit(selectedObject);
      });
    },
    gesture,
    view,
    scene: () => ({
      shapes: shapes(),
      pending: pending.filter((g) => g.pageId === pageId),
      view: view(),
      tool: tools.value === 'text' ? 'pen' : tools.value,
      selected: [...selected],
      radius: Number(element<HTMLInputElement>('radius').value),
    }),
    moveTargets(point) {
      const bounds = selectionBounds(shapes().filter((s) => selected.has(s.id)));
      const pad = (8 * view().width) / canvas.getBoundingClientRect().width;
      return bounds &&
        point.x >= bounds.x - pad &&
        point.x <= bounds.x + bounds.width + pad &&
        point.y >= bounds.y - pad &&
        point.y <= bounds.y + bounds.height + pad
        ? [...selected]
        : [];
    },
    onActive(value) {
      if (value) selectedObject = 0;
      active = value;
      refresh();
    },
    onPan(value) {
      views.pan(page()!, value);
      refresh();
    },
    onNavigate(dx, dy, factor, anchor) {
      const current = page();
      if (!current) return;
      if (current.kind === 'whiteboard') {
        const before = view(),
          rect = canvas.getBoundingClientRect();
        if (factor !== 1) views.zoom(current, 1 / factor);
        const after = view();
        views.pan(current, {
          ...after,
          x:
            before.x +
            ((anchor.x - rect.left) / rect.width) * (before.width - after.width) -
            (dx * after.width) / rect.width,
          y:
            before.y +
            ((anchor.y - rect.top) / rect.height) * (before.height - after.height) -
            (dy * after.height) / rect.height,
        });
      } else {
        if (factor !== 1) surface.scale(factor, anchor);
        surface.pan(dx, dy);
      }
      refresh();
    },
    onGesture(input) {
      unsaved.push(input);
      if (!input.cancelled) pending.push(input);
      const last = input.data.deliveries.at(-1)!;
      element('sample-info').textContent = JSON.stringify(
        {
          input: last.reported.pointerType,
          measuredSamples: measuredSamples(input.data).length,
          predictedSamples: input.data.deliveries.reduce((n, d) => n + d.predicted.length, 0),
          lastReported: last.reported,
          status: input.cancelled ? 'cancelled' : 'complete',
        },
        null,
        2,
      );
      edit(
        () => db.gesture(input, sessionId),
        () => {
          if (!input.cancelled && input.tool === 'lasso')
            selected = new Set(
              interactionPolicies.select(shapes(), measuredSamples(input.data), input.interaction),
            );
          pending = pending.filter((item) => item !== input);
          unsaved = unsaved.filter((item) => item !== input);
        },
      );
    },
  });
  function error(value: unknown) {
    notice.hidden = false;
    notice.className = 'error';
    notice.textContent = value instanceof Error ? value.message : String(value);
  }
  function chooseDocument(id: number) {
    void textEditor.flush();
    documentId = id;
    pageId = pages()[0]?.id ?? 0;
    selected.clear();
    refresh();
  }
  function refresh() {
    if (!state.objects.some((object) => object.id === selectedObject && object.page_id === pageId && object.rendered))
      selectedObject = 0;
    selected = new Set([...selected].filter((id) => shapes().some((s) => s.id === id)));
    const busy = !ready || failed || active || writes > 0 || resetting || importing;
    const board = page()?.kind === 'whiteboard';
    tools.update({ disabled: busy, whiteboard: board });
    paints.select(tools.value === 'text' ? 'pen' : tools.value);
    inkControls.update(busy);
    textEditor.update(
      pageId,
      state.objects.filter((o) => o.page_id === pageId),
      !ready || failed || active || resetting || importing,
    );
    navigation.update(pages(), pageId, busy);
    for (const id of [
      'document',
      'document-name',
      'rename-document',
      'new-document',
      'pdf-file',
      'pdf-url',
      'import-url',
      'notebook-file',
      'new-notebook',
      'restore-backup',
      'image-file',
      'image-as-object',
      'insert-pdf',
      'page-size',
      'add-page',
      'color',
      'width',
      'radius',
      'touch',
      'zoom-in',
      'zoom-out',
      'home-view',
      'toggle-text',
      'insert-page-text',
      'jsonl-file',
      'lasso-policy',
    ]) {
      (element(id) as HTMLInputElement | HTMLButtonElement | HTMLSelectElement).disabled = busy;
    }
    element<HTMLButtonElement>('undo').disabled = busy || !state.undoablePages.includes(pageId);
    element<HTMLButtonElement>('redo').disabled = busy || !state.redoablePages.includes(pageId);
    element<HTMLButtonElement>('clear').disabled = busy || !shapes().length;
    element<HTMLButtonElement>('delete-page').disabled = busy || pages().length <= 1;
    element<HTMLButtonElement>('page-earlier').disabled = busy || page()?.page_number === 1;
    element<HTMLButtonElement>('page-later').disabled = busy || page()?.page_number === pages().length;
    for (const id of [
      'delete-selection',
      'deselect',
      'apply-processing',
      'copy-selection',
      'duplicate-selection',
      'shrink-selection',
      'grow-selection',
      'rotate-selection',
    ])
      element<HTMLButtonElement>(id).disabled = busy || !selected.size;
    element<HTMLButtonElement>('paste-selection').disabled = busy || !clipboard.length;
    element('selection-controls').hidden = tools.value !== 'lasso';
    element('selection-count').textContent = selected.size + ' selected';
    element<HTMLButtonElement>('export-full').disabled = !ready || active || writes > 0 || importing;
    for (const id of ['export-visible', 'export-drawn', 'export-pdf', 'export-jsonl', 'browse-pages'])
      element<HTMLButtonElement>(id).disabled = busy;
    for (const id of ['reset-settings', 'reset-local', 'export-existing']) {
      element<HTMLButtonElement>(id).disabled =
        active || writes > 0 || !ownsDatabase || resetting || importing;
    }
    element('recover').hidden = !failed || (!unsaved.length && !textEditor.dirty);
    element('counts').textContent =
      shapes().length + ' visible · ' + state.rawCount + ' raw strokes · ' + state.eventCount + ' events';
    element('save-state').textContent = failed
      ? 'Could not save'
      : !ready
        ? 'Not open'
        : importing
          ? 'Loading notebook content…'
          : active
            ? 'Drawing'
            : writes
              ? 'Saving…'
              : textEditor.dirty
                ? 'Unsaved text'
                : background === 'loading'
                  ? 'Loading background…'
                  : background === 'error'
                    ? 'Background unavailable'
                    : 'Saved';
    documentControls.update(state.documents, documentId, busy);
    paints.update(busy);
    element('document-hash').textContent =
      page()?.source_hash ?? 'Page source: ' + (page()?.source_kind ?? 'blank');
    element('page-heading').textContent = (currentDocument()?.name ?? '') + '/' + (page()?.page_number ?? 1);
    element('blank-page-controls').hidden = false;
    if (ready) location.write(documentId, pageId);
    element('board-controls').hidden = !board;
    const painting = ['pen', 'highlighter', 'restyle'].includes(tools.value);
    element('paint-toolbar').hidden = !painting;
    element('width-control').hidden = !painting;
    element('eraser-control').hidden = !tools.value.startsWith('erase') && tools.value !== 'restyle';
    const box = view();
    canvas.dataset.viewWidth = String(box.width);
    canvas.dataset.viewHeight = String(box.height);
    element('view-position').textContent =
      'x ' + Math.round(box.x) + ', y ' + Math.round(box.y) + ' · ' + Math.round(100000 / box.width) + '%';
    surface.update(page(), currentDocument());
    notebook.repaint();
    extensions?.update({ state, documentId, pageId, sessionId, ready, busy });
    indicators.update({ state, documentId, pageId, sessionId, ready, busy });
    pdfText.update(page(), element<HTMLInputElement>('select-pdf-text').checked);
    pageObjects.update(
      state.objects.filter((o) => o.page_id === pageId),
      element<HTMLInputElement>('show-boxes').checked ? state.boxes.filter((b) => b.page_id === pageId) : [],
      box,
      (!element('text-panel').hidden || tools.value === 'text' || tools.value === 'lasso') &&
        ready &&
        !failed &&
        !active &&
        !resetting &&
        !importing,
      tools.value === 'lasso' && !busy,
      selectedObject || (!element('text-panel').hidden ? textEditor.selectedId : 0),
    );
  }
  function edit(work: () => Promise<State>, after?: () => void, fatal = true) {
    writes++;
    refresh();
    operations = operations.then(async () => {
      try {
        if (failed) return;
        state = await work();
        after?.();
        if (!page()) pageId = pages()[0]?.id ?? 0;
        if (tab !== 'notebook') void viewer.refresh();
      } catch (value) {
        if (fatal) failed = true;
        error(value);
      } finally {
        writes--;
        refresh();
      }
    });
    return operations;
  }
  async function open(result: Initialized) {
    if (result.mode === 'blocked') {
      ownsDatabase = false;
      notice.hidden = false;
      notice.textContent = 'Notebook already open in another tab. Close that tab, then reload this one.';
      element('storage').textContent = 'Open in another tab';
      element('recovery-actions').hidden = true;
    } else {
      state = result.state;
      sessionId = result.sessionId;
      ready = true;
      failed = false;
      documentId = state.documents.some((d) => d.id === documentId) ? documentId : state.documents[0].id;
      pageId = pages().some((p) => p.id === pageId) ? pageId : pages()[0].id;
      pending = [];
      unsaved = [];
      notice.hidden = result.mode === 'persistent';
      notice.className = '';
      element('storage').textContent =
        result.mode === 'persistent' ? 'Stored on this device' : 'Session only · export to keep';
      if (result.mode === 'temporary')
        notice.textContent =
          'Persistent browser storage is unavailable. Export before closing. Use HTTPS or localhost.';
      element('recovery-actions').hidden = true;
      if (result.report) {
        const { accepted, skipped, missingLinks, recoveryPage } = result.report;
        const message = `Reconstructed ${accepted} edits; ${skipped.length} skipped, ${missingLinks} missing links.${recoveryPage ? ' Added a blank recovery page.' : ''}`;
        element('replay-report').textContent = message;
        if (skipped.length || missingLinks || recoveryPage) {
          notice.hidden = false;
          notice.textContent = message;
        }
      }
    }
    refresh();
  }
  async function reset() {
    if (!ownsDatabase || active || writes || resetting || importing) return;
    if (
      !confirm(
        'Delete all local documents, PDFs, pages, captures and edit history? Export anything you want to keep first.',
      )
    )
      return;
    resetting = true;
    refresh();
    try {
      await operations;
      textEditor.clear();
      views.clear();
      selected.clear();
      documentId = 1;
      pageId = 1;
      await open(await db.reset(session));
      setTab('notebook');
    } catch (value) {
      error(value);
    } finally {
      resetting = false;
      refresh();
    }
  }
  function setTab(name: string) {
    if (active) return;
    viewer.hide();
    void textEditor.flush();
    tab = name;
    options.open = false;
    document
      .querySelectorAll<HTMLButtonElement>('[data-tab]')
      .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === name)));
    element('notebook-panel').hidden = name !== 'notebook';
    element('viewer-panel').hidden = name === 'notebook';
    element('return-notebook').hidden = name === 'notebook';
    if (name !== 'notebook') {
      if (ready) void viewer.show(name === 'raw');
      else element('viewer-panel').textContent = 'Open or reset the local notebook to inspect its database.';
    }
    notebook.repaint();
  }
  document
    .querySelectorAll<HTMLButtonElement>('[data-tab]')
    .forEach((b) => (b.onclick = () => setTab(b.dataset.tab!)));
  element('return-notebook').onclick = () => setTab('notebook');
  function showText(open: boolean) {
    element('text-panel').hidden = !open;
    element('toggle-text').setAttribute('aria-expanded', String(open));
    if (!open) void textEditor.flush();
    refresh();
  }
  element('toggle-text').onclick = () => showText(Boolean(element('text-panel').hidden));
  const insertText = async () => {
    tools.select('text');
    await textEditor.create(true);
    pageObjects.edit(selectedObject);
  };
  element('show-boxes').onchange = () => refresh();
  element('select-pdf-text').onchange = () => refresh();
  element('browse-pages').onclick = () => {
    void browser.show(state, documentId).catch(error);
  };
  element('new-document').onclick = () => {
    void edit(
      () => db.createDocument('Notes'),
      () => chooseDocument(state.documents.at(-1)!.id),
    );
  };
  element('undo').onclick = () => {
    const targetPage = pageId;
    void textEditor.flush().then(() => edit(() => db.undo(targetPage), undefined, false));
  };
  element('redo').onclick = () => {
    void textEditor.flushAll().then(() => edit(() => db.redo(pageId), undefined, false));
  };
  element('clear').onclick = () => {
    void edit(() => db.clear(pageId));
  };
  element('delete-selection').onclick = () => {
    void edit(
      () => db.deleteShapes(pageId, [...selected]),
      () => selected.clear(),
    );
  };
  element('apply-processing').onclick = () => {
    const policy = inkControls.value,
      ids = [...selected],
      targetPage = pageId;
    void edit(
      () => db.reprocess(targetPage, ids, policy),
      () => selected.clear(),
    );
  };
  element('deselect').onclick = () => {
    selected.clear();
    refresh();
  };
  element('add-page').onclick = () => {
    const { width, height } = PAGE_PRESETS.find(
      (p) => p.id === element<HTMLSelectElement>('page-size').value,
    )!;
    const before = new Set(state.pages.map((p) => p.id));
    void edit(
      () => db.addPage(documentId, pageId, width, height),
      () => selectPage(state.pages.find((p) => !before.has(p.id))!.id),
    );
  };
  for (const [id, action] of [
    ['page-earlier', 'earlier'],
    ['page-later', 'later'],
    ['delete-page', 'delete'],
  ] as const) {
    element(id).onclick = () => {
      void textEditor.flush();
      void edit(() => db.changePage(pageId, action));
    };
  }
  async function importPdf(load: () => Promise<{ bytes: Uint8Array; name: string }>) {
    if (!ready || importing || active || writes) return;
    importing = true;
    notice.hidden = true;
    refresh();
    try {
      await textEditor.flushAll();
      await operations;
      if (failed) throw new Error('Save text drafts before importing a PDF.');
      const { bytes, name } = await load();
      if (bytes.length > MAX_PDF_BYTES) throw new Error('PDF exceeds the 200 MiB import limit');
      const hash = await identifyPdf(bytes),
        pdfPages = await pdfs.inspect(bytes);
      surface.invalidate();
      if (element<HTMLInputElement>('insert-pdf').checked) {
        const before = new Set(state.pages.map((p) => p.id));
        state = await db.insertPdf({ hash, name, bytes, pages: pdfPages }, documentId, pageId);
        selectPage(state.pages.find((p) => !before.has(p.id))!.id);
      } else {
        state = await db.importPdf({ hash, name, bytes, pages: pdfPages });
        chooseDocument(state.documents.find((d) => d.pdf_hash === hash)!.id);
      }
      options.open = false;
      setTab('notebook');
    } catch (value) {
      error(value);
    } finally {
      importing = false;
      refresh();
    }
  }
  element<HTMLInputElement>('pdf-file').onchange = () => {
    const input = element<HTMLInputElement>('pdf-file'),
      file = input.files?.[0];
    if (file)
      void importPdf(async () => {
        if (file.size > MAX_PDF_BYTES) throw new Error('PDF exceeds the 200 MiB import limit');
        return { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name.replace(/\.pdf$/i, '') };
      });
    input.value = '';
  };
  element('pdf-url-form').onsubmit = (event) => {
    event.preventDefault();
    void importPdf(() => readPdfUrl(element<HTMLInputElement>('pdf-url').value));
  };
  async function exportDb(kind: 'full' | 'visible' | 'drawn') {
    try {
      await textEditor.flushAll();
      await operations;
      download(
        await db.export(kind, element<HTMLInputElement>('include-blobs').checked),
        'application/vnd.sqlite3',
        'event-draw-' + kind + '.sqlite3',
      );
      document.querySelector<HTMLDetailsElement>('.export-menu')!.open = false;
      if (textEditor.dirty)
        error('SQLite contains saved records only. Use Export unsaved input to keep the text drafts too.');
    } catch (value) {
      error(value);
    }
  }
  element('export-jsonl').onclick = () => {
    void (async () => {
      try {
        await textEditor.flushAll();
        await operations;
        if (textEditor.dirty) throw new Error('Save text drafts before exporting events.');
        download(
          await db.exportEventStream(element<HTMLInputElement>('include-blobs').checked),
          'application/x-ndjson',
          'event-draw.jsonl',
        );
        document.querySelector<HTMLDetailsElement>('.export-menu')!.open = false;
      } catch (value) {
        error(value);
      }
    })();
  };
  element('export-full').onclick = () => {
    void exportDb('full');
  };
  element('export-visible').onclick = () => {
    void exportDb('visible');
  };
  element('export-drawn').onclick = () => {
    void exportDb('drawn');
  };
  element('export-existing').onclick = () => {
    void exportDb('full');
  };
  element('reset-local').onclick = () => {
    void reset();
  };
  element('reset-settings').onclick = () => {
    void reset();
  };
  element('recover').onclick = () =>
    download(
      JSON.stringify({ session, gestures: unsaved, textDrafts: textEditor.recovery() }, null, 2),
      'application/json',
      'event-draw-unsaved.json',
    );
  function zoom(factor: number) {
    if (page()?.kind === 'whiteboard') views.zoom(page()!, 1 / factor);
    else surface.scale(factor);
    refresh();
  }
  element('zoom-in').onclick = () => zoom(1.25);
  element('zoom-out').onclick = () => zoom(0.8);
  element('home-view').onclick = () => {
    views.reset(pageId);
    surface.reset();
    refresh();
  };
  const copySelection = async () => {
    try {
      clipboard = await db.copyShapes(pageId, [...selected]);
      refresh();
    } catch (value) {
      error(value);
    }
  };
  const pasteSelection = () => {
    const before = new Set(state.shapes.map((s) => s.id));
    void edit(
      () => db.pasteShapes(pageId, clipboard),
      () => {
        selected = new Set(
          shapes()
            .filter((s) => !before.has(s.id))
            .map((s) => s.id),
        );
      },
      false,
    );
  };
  element('copy-selection').onclick = () => {
    void copySelection();
  };
  element('paste-selection').onclick = pasteSelection;
  element('duplicate-selection').onclick = () => {
    void copySelection().then(pasteSelection);
  };
  for (const [id, change] of [
    ['shrink-selection', { scale: 0.8 }],
    ['grow-selection', { scale: 1.25 }],
    ['rotate-selection', { rotation: Math.PI / 12 }],
  ] as const)
    element(id).onclick = () => {
      void edit(() => db.transformShapes(pageId, [...selected], change), undefined, false);
    };
  const files = new NotebookFiles(db, session, {
    canReplace: () => ready && !failed && !active && !writes && !importing,
    canBackup: () => ready && !failed && !active && !writes && !importing && !textEditor.dirty,
    revision: () => state.eventCount,
    async flush() {
      await textEditor.flushAll();
      await operations;
      if (textEditor.dirty)
        throw new Error('Save text drafts or export unsaved input before replacing this notebook.');
    },
    busy(value) {
      importing = value;
      refresh();
    },
    async replaced(result, name) {
      surface.invalidate();
      pdfText.update(undefined, false);
      pdfs.close();
      textEditor.clear();
      views.clear();
      selected.clear();
      pending = [];
      documentId = 1;
      pageId = 1;
      await open(result);
      element('notebook-name').textContent = name;
      setTab('notebook');
      options.open = false;
    },
    error,
  });
  element<HTMLInputElement>('image-file').onchange = () => {
    const input = element<HTMLInputElement>('image-file'),
      file = input.files?.[0];
    input.value = '';
    if (!file || !ready || importing || active || writes) return;
    importing = true;
    refresh();
    void (async () => {
      try {
        await textEditor.flushAll();
        await operations;
        if (file.size > MAX_PDF_BYTES) throw new Error('Image exceeds 200 MiB');
        const bytes = new Uint8Array(await file.arrayBuffer()),
          image = await inspectImage(bytes, file.name, file.type),
          before = new Set(state.pages.map((p) => p.id));
        state = await db.importAsset({
          ...image,
          bytes,
          name: file.name,
          documentId,
          afterPageId: pageId,
          asObject: element<HTMLInputElement>('image-as-object').checked,
        });
        const added = state.pages.find((p) => !before.has(p.id));
        if (added) selectPage(added.id);
        options.open = false;
      } catch (value) {
        error(value);
      } finally {
        importing = false;
        refresh();
      }
    })();
  };
  element('export-pdf').onclick = () => {
    if (importing || writes || active) return;
    importing = true;
    refresh();
    void (async () => {
      try {
        await textEditor.flushAll();
        await operations;
        if (textEditor.dirty) throw new Error('Save text drafts before PDF export.');
        const { annotatedPdf } = await import('./pdf/export.ts');
        const bytes = await annotatedPdf(state, documentId, sources, (message) => {
          element('save-state').textContent = message;
        });
        download(bytes, 'application/pdf', (currentDocument()?.name || 'Notes') + '.pdf');
        document.querySelector<HTMLDetailsElement>('.export-menu')!.open = false;
      } catch (value) {
        error(value);
      } finally {
        importing = false;
        refresh();
      }
    })();
  };
  const closeShortcuts = keyboardShortcuts(
    {
      text: () => tools.select('text'),
      escape: () => {
        pageObjects.finishEditing();
        selectedObject = 0;
        tools.select('pen');
      },
      undo: () => element('undo').click(),
      redo: () => element('redo').click(),
      copy: () => element('copy-selection').click(),
      paste: pasteSelection,
      duplicate: () => element('duplicate-selection').click(),
      remove: () => {
        if (selectedObject) {
          const id = selectedObject;
          selectedObject = 0;
          void edit(() => db.deleteObject(pageId, id));
        } else element('delete-selection').click();
      },
      previous: () => element('previous-page').click(),
      next: () => element('next-page').click(),
      save: () => {
        void exportDb('full');
      },
      selectAll: () => {
        element<HTMLButtonElement>('tool-picker')
          .querySelector<HTMLButtonElement>('[data-tool=lasso]')!
          .click();
        selected = new Set(shapes().map((s) => s.id));
        refresh();
      },
    },
    () =>
      ready &&
      !failed &&
      !active &&
      !writes &&
      !importing &&
      tab === 'notebook' &&
      !element<HTMLDialogElement>('page-browser').open,
  );
  const backgroundSave = () => {
    if (document.hidden && !active && !importing) void textEditor.flushAll();
  };
  document.addEventListener('visibilitychange', backgroundSave);
  const unload = (event: BeforeUnloadEvent) => {
    if (active || writes || unsaved.length || importing || textEditor.dirty) event.preventDefault();
  };
  window.addEventListener('beforeunload', unload);
  const frontendSnapshot = () => ({
    state,
    documentId,
    pageId,
    sessionId,
    ready,
    busy: !ready || failed || active || writes > 0 || resetting || importing,
  });
  const host: FrontendHost = {
    snapshot: frontendSnapshot,
    subscribe: () => () => {}, // Each extension gets its own managed subscription.
    async execute(command, args) {
      if (!EDIT_COMMANDS.includes(command) || frontendSnapshot().busy) throw new Error('Edit unavailable');
      let failure: unknown;
      await edit(
        async () => {
          try {
            return await (db[command] as (...values: unknown[]) => Promise<State>).apply(db, [...args]);
          } catch (value) {
            failure = value;
            throw value;
          }
        },
        undefined,
        false,
      );
      if (failure) throw failure;
    },
    navigate(id) {
      const target = state.pages.find((p) => p.id === id);
      if (!target || frontendSnapshot().busy) return;
      documentId = target.document_id;
      selectPage(id);
    },
    insertText,
  };
  extensions = new FrontendExtensions(element('frontend-extensions'), config.extensions ?? [], host);
  void db
    .init(session)
    .then(open)
    .catch((value) => {
      failed = true;
      error(value);
      element('storage').textContent = 'Notebook could not open';
      element('recovery-actions').hidden = false;
      refresh();
    });
  refresh();
  return () => {
    indicators.close();
    extensions?.close();
    files.close();
    document.removeEventListener('visibilitychange', backgroundSave);
    closeShortcuts();
    browser.close();
    pdfText.close();
    textEditor.close();
    pageObjects.close();
    viewer.hide();
    surface.close();
    notebook.close();
    pdfs.close();
    db.close();
    window.removeEventListener('beforeunload', unload);
  };
}
