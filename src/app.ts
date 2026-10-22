import { captureSession } from './capture.ts';
import { DatabaseClient, type Initialized } from './database.ts';
import { download } from './download.ts';
import { EMPTY_STATE, measuredSamples, type Gesture, type Page, type State, type Tool, type ViewBox } from './model.ts';
import { NotebookCanvas } from './ui/canvas.ts';
import { mountShell, element } from './ui/shell.ts';
import { DatabaseViewer } from './ui/viewer.ts';

export function startApp(): () => void {
  mountShell();
  const db = new DatabaseClient();
  const session = captureSession();
  let state: State = EMPTY_STATE, sessionId = 0, pageId = 1;
  let ready = false, failed = false, active = false, writes = 0, ownsDatabase = true, resetting = false;
  let mode: 'persistent' | 'temporary' | 'blocked' = 'temporary';
  let tab = 'notebook';
  let pending: Gesture[] = [], unsaved: Gesture[] = [];
  let operations: Promise<void> = Promise.resolve();
  const views = new Map<number, ViewBox>();
  const canvas = element<HTMLCanvasElement>('canvas');
  const tool = element<HTMLSelectElement>('tool');
  const pageSelect = element<HTMLSelectElement>('page');
  const notice = element('notice');
  const viewer = new DatabaseViewer(element('viewer-panel'), db);
  const page = (): Page | undefined => state.pages.find((p) => p.id === pageId);
  const shapes = () => state.shapes.filter((s) => s.page_id === pageId);
  const view = (): ViewBox => {
    const current = page();
    return current?.kind === 'whiteboard' ? views.get(pageId) ??
      { x: 0, y: 0, width: 1000, height: 750 } :
      { x: 0, y: 0, width: current?.width ?? 1000, height: current?.height ?? 1200 };
  };
  const gesture = (): Gesture => ({
    pageId, tool: tool.value as Gesture['tool'],
    style: { color: element<HTMLInputElement>('color').value,
      lineWidth: Number(element<HTMLInputElement>('width').value) },
    radius: Number(element<HTMLInputElement>('radius').value), cancelled: false, data: { deliveries: [] },
  });
  const notebook = new NotebookCanvas(canvas, {
    canStart: () => ready && !failed && (tool.value === 'pen' || writes === 0),
    touchEnabled: () => element<HTMLInputElement>('touch').checked,
    tool: () => tool.value as Tool, gesture, view,
    scene: () => ({ shapes: shapes(), pending: pending.filter((g) => g.pageId === pageId),
      view: view(), tool: tool.value, radius: Number(element<HTMLInputElement>('radius').value) }),
    onActive(value) { active = value; refresh(); },
    onPan(value) { views.set(pageId, value); refresh(); },
    onGesture(input) {
      unsaved.push(input);
      if (!input.cancelled) pending.push(input);
      const last = input.data.deliveries.at(-1)!;
      element('sample-info').textContent = JSON.stringify({
        input: last.reported.pointerType, measuredSamples: measuredSamples(input.data).length,
        predictedSamples: input.data.deliveries.reduce((n, d) => n + d.predicted.length, 0),
        lastReported: last.reported, status: input.cancelled ? 'cancelled' : 'complete',
      }, null, 2);
      edit(() => db.gesture(input, sessionId), () => {
        pending = pending.filter((item) => item !== input);
        unsaved = unsaved.filter((item) => item !== input);
      });
    },
  });
  function error(value: unknown) {
    notice.hidden = false; notice.className = 'error';
    notice.textContent = value instanceof Error ? value.message : String(value);
  }
  function refresh() {
    const busy = !ready || failed || active || writes > 0 || resetting;
    for (const id of ['page', 'page-size', 'add-page', 'tool', 'color', 'width', 'radius', 'touch',
      'zoom-in', 'zoom-out', 'home-view']) {
      (element(id) as HTMLInputElement | HTMLButtonElement | HTMLSelectElement).disabled = busy;
    }
    element<HTMLButtonElement>('undo').disabled = busy || !state.undoablePages.includes(pageId);
    element<HTMLButtonElement>('clear').disabled = busy || !shapes().length;
    element<HTMLButtonElement>('export-full').disabled = !ready || active || writes > 0;
    element<HTMLButtonElement>('export-visible').disabled = !ready || active || writes > 0 || failed;
    for (const id of ['reset-settings', 'reset-local', 'export-existing']) {
      element<HTMLButtonElement>(id).disabled = active || writes > 0 || !ownsDatabase || resetting;
    }
    element('recover').hidden = !failed || !unsaved.length;
    element('counts').textContent = shapes().length + ' visible · ' + state.rawCount +
      ' raw strokes · ' + state.eventCount + ' events';
    element('save-state').textContent = failed ? 'Could not save — export before resetting' :
      !ready ? 'Not open' : active ? 'Drawing' : writes ? 'Saving…' : 'Saved';
    pageSelect.replaceChildren(...state.pages.map((p) => new Option(p.title, String(p.id), false, p.id === pageId)));
    element('page-heading').textContent = (page()?.title ?? 'Untitled').toUpperCase() + ' / ' + pageId;
    const board = page()?.kind === 'whiteboard';
    element('board-controls').hidden = !board;
    const panOption = tool.querySelector<HTMLOptionElement>('option[value="pan"]')!;
    panOption.disabled = !board;
    if (!board && tool.value === 'pan') tool.value = 'pen';
    element('color-control').hidden = tool.value !== 'pen';
    element('width-control').hidden = tool.value !== 'pen';
    element('eraser-control').hidden = !tool.value.startsWith('erase');
    const box = view();
    canvas.style.aspectRatio = box.width + ' / ' + box.height;
    canvas.parentElement!.classList.toggle('whiteboard', board);
    element('view-position').textContent = 'x ' + Math.round(box.x) + ', y ' + Math.round(box.y) +
      ' · ' + Math.round(100000 / box.width) + '%';
    notebook.repaint();
  }
  function edit(work: () => Promise<State>, after?: () => void) {
    writes++; refresh();
    operations = operations.then(async () => {
      try {
        if (failed) return;
        state = await work();
        after?.();
        if (tab !== 'notebook') void viewer.refresh();
      } catch (value) { failed = true; error(value); }
      finally { writes--; refresh(); }
    });
  }
  async function open(result: Initialized) {
    mode = result.mode;
    if (result.mode === 'blocked') {
      ownsDatabase = false;
      notice.hidden = false;
      notice.textContent = 'Notebook already open in another tab. Close that tab, then reload this one.';
      element('storage').textContent = 'Open in another tab';
      element('recovery-actions').hidden = true;
    } else {
      state = result.state; sessionId = result.sessionId; ready = true; failed = false;
      pageId = state.pages.some((p) => p.id === pageId) ? pageId : state.pages[0].id;
      pending = []; unsaved = []; notice.hidden = result.mode === 'persistent'; notice.className = '';
      element('storage').textContent = result.mode === 'persistent' ? 'Stored on this device' : 'Session only · export to keep';
      if (result.mode === 'temporary') {
        notice.textContent = 'Persistent browser storage is unavailable. Export before closing. Use a trusted HTTPS origin or localhost.';
        notice.title = result.storageError ?? '';
      }
      element('recovery-actions').hidden = true;
    }
    element('storage').classList.toggle('temporary', mode !== 'persistent');
    refresh();
  }
  async function reset() {
    if (!ownsDatabase || active || writes || resetting) return;
    if (!confirm('Delete all pages, captures and edit history stored locally in this browser? Export anything you want to keep first.')) return;
    resetting = true; refresh();
    try {
      await operations;
      views.clear(); pageId = 1;
      await open(await db.reset(session));
      setTab('notebook');
    } catch (value) { error(value); }
    finally { resetting = false; refresh(); }
  }
  function setTab(name: string) {
    if (active) return;
    tab = name;
    document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((button) =>
      button.setAttribute('aria-pressed', String(button.dataset.tab === name)));
    element('notebook-panel').hidden = name !== 'notebook';
    element('viewer-panel').hidden = name === 'notebook';
    if (name !== 'notebook') {
      if (ready) void viewer.show(name === 'raw');
      else element('viewer-panel').textContent = 'Open or reset the local notebook to inspect its database.';
    }
    notebook.repaint();
  }
  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((button) => {
    button.onclick = () => setTab(button.dataset.tab!);
  });
  pageSelect.onchange = () => { pageId = Number(pageSelect.value); refresh(); };
  tool.onchange = refresh;
  element('undo').onclick = () => edit(() => db.undo(pageId));
  element('clear').onclick = () => edit(() => db.clear(pageId));
  element('add-page').onclick = () => {
    const sizes: Record<string, [number | null, number | null, string]> = {
      a4: [595, 842, 'A4'], letter: [612, 792, 'Letter'], landscape: [842, 595, 'Landscape'],
      square: [1000, 1000, 'Square'], whiteboard: [null, null, 'Whiteboard'],
    };
    const [width, height, name] = sizes[element<HTMLSelectElement>('page-size').value];
    edit(() => db.addPage(name + ' ' + (state.pages.length + 1), width, height),
      () => { pageId = state.pages.at(-1)!.id; });
  };
  async function exportDb(kind: 'full' | 'visible') {
    try {
      await operations;
      download(await db.export(kind), 'application/vnd.sqlite3', 'event-draw-' + kind + '.sqlite3');
      document.querySelector<HTMLDetailsElement>('.export-menu')!.open = false;
    } catch (value) { error(value); }
  }
  element('export-full').onclick = () => { void exportDb('full'); };
  element('export-visible').onclick = () => { void exportDb('visible'); };
  element('export-existing').onclick = () => { void exportDb('full'); };
  element('reset-local').onclick = () => { void reset(); };
  element('reset-settings').onclick = () => { void reset(); };
  element('recover').onclick = () => download(JSON.stringify({ session, gestures: unsaved }, null, 2),
    'application/json', 'event-draw-unsaved.json');
  function zoom(factor: number) {
    const current = view();
    if (current.width * factor < 50 || current.width * factor > 1e7) return;
    views.set(pageId, { x: current.x + current.width * (1 - factor) / 2,
      y: current.y + current.height * (1 - factor) / 2,
      width: current.width * factor, height: current.height * factor });
    refresh();
  }
  element('zoom-in').onclick = () => zoom(0.8);
  element('zoom-out').onclick = () => zoom(1.25);
  element('home-view').onclick = () => { views.delete(pageId); refresh(); };
  const unload = (event: BeforeUnloadEvent) => {
    if (active || writes || unsaved.length) event.preventDefault();
  };
  window.addEventListener('beforeunload', unload);
  void db.init(session).then(open).catch((value) => {
    failed = true; error(value);
    element('storage').textContent = 'Notebook could not open';
    element('recovery-actions').hidden = false;
    refresh();
  });
  refresh();
  return () => { notebook.close(); db.close(); window.removeEventListener('beforeunload', unload); };
}
