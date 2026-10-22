import './style.css';
import { captureDelivery, captureSession } from './capture.ts';
import { DatabaseClient } from './database.ts';
import { measuredSamples, type State, type StrokeInput } from './model.ts';
import { render } from './render.ts';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <header>
    <div class="brand"><span class="mark" aria-hidden="true">e.</span><div>
      <h1>Event Draw</h1><p>A page to think on.</p>
    </div></div>
    <span id="storage" class="storage" role="status">Opening notebook…</span>
  </header>
  <main>
    <section class="toolbar" aria-label="Drawing tools">
      <div class="tools">
        <label class="color-label">Ink <input id="color" type="color" value="#203b42" aria-label="Ink color"></label>
        <label>Width <input id="width" type="range" min="1" max="12" value="3" aria-label="Pen width"></label>
        <label class="touch-label"><input id="touch" type="checkbox" checked> Finger drawing</label>
      </div>
      <div class="actions">
        <button id="undo" disabled>Undo</button>
        <button id="clear" disabled>Clear page</button>
        <details class="export-menu">
          <summary>Export SQLite <span aria-hidden="true">↓</span></summary>
          <div class="export-options">
            <button id="export-full" disabled>Full history</button>
            <button id="export-visible" disabled>Visible state only</button>
            <p>Visible state keeps the drawing and drops earlier edits.</p>
          </div>
        </details>
      </div>
    </section>
    <div id="notice" role="status" hidden></div>
    <div class="page-heading"><span>UNTITLED / 01</span><span id="save-state" role="status">Loading</span></div>
    <div class="paper">
      <canvas id="canvas" aria-label="Drawing page. Draw with a pen, mouse, or finger."></canvas>
    </div>
    <footer>
      <span id="counts">0 visible shapes</span>
      <details id="diagnostics">
        <summary>Capture details</summary>
        <p>Reported pressure may be a browser default. Hardware support is unknown.</p>
        <pre id="sample-info">Draw a stroke to inspect its input.</pre>
      </details>
    </footer>
  </main>
`;

function element<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
const canvas = element<HTMLCanvasElement>('canvas');
const undo = element<HTMLButtonElement>('undo');
const clear = element<HTMLButtonElement>('clear');
const fullExport = element<HTMLButtonElement>('export-full');
const visibleExport = element<HTMLButtonElement>('export-visible');
const color = element<HTMLInputElement>('color');
const width = element<HTMLInputElement>('width');
const touch = element<HTMLInputElement>('touch');
const notice = element('notice');
const storage = element('storage');
const saveState = element('save-state');
const counts = element('counts');
const sampleInfo = element('sample-info');
const db = new DatabaseClient();
let state: State = { strokes: [], shapeCount: 0, eventCount: 0, canUndo: false };
let sessionId: number;
let initialized = false;
let active: { pointerId: number; stroke: StrokeInput } | null = null;
let pending: StrokeInput[] = [];
let unsaved: StrokeInput[] = [];
let writeCount = 0;
let failed = false;
let frame = 0;
// Serialize edits/exports so an export includes every preceding completed stroke.
let operations: Promise<void> = Promise.resolve();

function repaint() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    render(canvas, state.strokes, [...pending, ...(active ? [active.stroke] : [])]);
  });
}

function refresh() {
  const busy = !initialized || failed || !!active || writeCount > 0;
  undo.disabled = busy || !state.canUndo;
  clear.disabled = busy || !state.strokes.length;
  fullExport.disabled = !initialized || !!active || writeCount > 0;
  visibleExport.disabled = fullExport.disabled;
  recovery.hidden = !failed || !unsaved.length;
  counts.textContent = state.strokes.length + ' visible · ' + state.shapeCount +
    ' captured · ' + state.eventCount + ' app events';
  saveState.textContent = failed ? 'Save failed — reload after exporting' :
    active ? 'Drawing' : writeCount ? 'Saving…' : initialized ? 'Saved' : 'Loading';
  repaint();
}

function reportError(error: unknown) {
  notice.hidden = false;
  notice.className = 'error';
  notice.textContent = error instanceof Error ? error.message : String(error);
}

function edit(work: () => Promise<State>, onSaved?: () => void) {
  writeCount++;
  refresh();
  operations = operations.then(async () => {
    try {
      if (failed) return;
      state = await work();
      onSaved?.();
    } catch (error) {
      failed = true;
      reportError(error);
    } finally {
      writeCount--;
      refresh();
    }
  });
}

function record(event: PointerEvent) {
  if (!active || event.pointerId !== active.pointerId) return;
  active.stroke.data.deliveries.push(captureDelivery(event, canvas));
  repaint();
}

canvas.addEventListener('pointerdown', (event) => {
  if (!initialized || failed || active || event.button !== 0) return;
  if (event.pointerType === 'touch' && !touch.checked) return;
  active = {
    pointerId: event.pointerId,
    stroke: { kind: 'ink', dataVersion: 1, status: 'complete',
      color: color.value, width: Number(width.value), data: { deliveries: [] } },
  };
  canvas.setPointerCapture(event.pointerId);
  record(event);
  refresh();
});
canvas.addEventListener('pointermove', record);
canvas.addEventListener('pointerrawupdate', (event) => record(event as PointerEvent));

function finish(event: PointerEvent, cancelled: boolean) {
  if (!active || event.pointerId !== active.pointerId) return;
  record(event);
  const stroke = active.stroke;
  stroke.status = cancelled ? 'cancelled' : 'complete';
  active = null;
  unsaved.push(stroke);
  if (!cancelled) pending.push(stroke);
  const last = stroke.data.deliveries.at(-1)!;
  sampleInfo.textContent = JSON.stringify({
    input: last.reported.pointerType,
    deliveries: stroke.data.deliveries.length,
    measuredSamples: measuredSamples(stroke.data).length,
    predictedSamples: stroke.data.deliveries.reduce((n, d) => n + d.predicted.length, 0),
    lastReported: last.reported,
    status: stroke.status,
  }, null, 2);
  edit(() => db.add(stroke, sessionId), () => {
    pending = pending.filter((item) => item !== stroke);
    unsaved = unsaved.filter((item) => item !== stroke);
  });
}
canvas.addEventListener('pointerup', (event) => finish(event, false));
canvas.addEventListener('pointercancel', (event) => finish(event, true));
canvas.addEventListener('lostpointercapture', (event) => finish(event, true));

undo.addEventListener('click', () => edit(() => db.undo()));
clear.addEventListener('click', () => edit(() => db.clear()));

function download(bytes: BlobPart, type: string, filename: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function exportDatabase(mode: 'full' | 'visible') {
  try {
    await operations;
    const bytes = await db.export(mode);
    download(bytes, 'application/vnd.sqlite3', 'event-draw-' + mode + '.sqlite3');
    document.querySelector<HTMLDetailsElement>('.export-menu')!.open = false;
  } catch (error) { reportError(error); }
}
fullExport.addEventListener('click', () => { void exportDatabase('full'); });
visibleExport.addEventListener('click', () => { void exportDatabase('visible'); });

// If a write fails, keep the stroke data accessible independently of SQLite.
const recovery = document.createElement('button');
recovery.textContent = 'Export unsaved strokes (JSON)';
recovery.addEventListener('click', () => {
  download(JSON.stringify({ session: sessionMetadata, strokes: unsaved }, null, 2),
    'application/json', 'event-draw-unsaved.json');
});
notice.after(recovery);
recovery.hidden = true;

window.addEventListener('beforeunload', (event) => {
  if (active || writeCount || failed) event.preventDefault();
});
new ResizeObserver(repaint).observe(canvas);
const sessionMetadata = captureSession();
void db.init(sessionMetadata).then((result) => {
  state = result.state;
  sessionId = result.sessionId;
  initialized = true;
  storage.textContent = result.persistent ? 'Stored on this device' : 'Session only · export to keep';
  storage.classList.toggle('temporary', !result.persistent);
  if (!result.persistent) {
    notice.hidden = false;
    notice.textContent = 'Browser storage is unavailable. Export before closing. Use HTTPS or localhost, ' +
      'and close other Event Draw tabs to enable storage.';
    notice.title = result.storageError ?? '';
  }
  refresh();
}).catch((error) => {
  failed = true;
  storage.textContent = 'Notebook could not open';
  reportError(error);
  refresh();
});
repaint();
