export function element<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
export function mountShell() {
  element('app').innerHTML = `
  <header>
    <div class="brand"><span class="mark" aria-hidden="true">e.</span><div>
      <h1>Event Draw</h1><p>A page to think on.</p>
    </div></div>
    <span id="storage" class="storage" role="status">Opening notebook…</span>
  </header>
  <main>
    <nav class="tabs" aria-label="Views">
      <button data-tab="notebook" aria-pressed="true">Notebook</button>
      <button data-tab="events" aria-pressed="false">Events</button>
      <button data-tab="raw" aria-pressed="false">Raw strokes</button>
    </nav>
    <div id="notice" role="status" hidden></div>
    <div id="recovery-actions" hidden>
      <button id="export-existing">Export existing SQLite</button>
      <button id="reset-local">Reset local notebook</button>
    </div>
    <button id="recover" hidden>Export unsaved gestures (JSON)</button>
    <section id="notebook-panel">
      <section class="page-tools" aria-label="Pages">
        <label>Page <select id="page" aria-label="Current page"></select></label>
        <label>New page <select id="page-size" aria-label="New page size">
          <option value="a4">A4 portrait</option><option value="letter">US Letter</option>
          <option value="landscape">A4 landscape</option><option value="square">Square</option>
          <option value="whiteboard">Infinite whiteboard</option>
        </select></label>
        <button id="add-page" disabled>Add page</button>
      </section>
      <section class="toolbar" aria-label="Drawing tools">
        <div class="tools">
          <label>Tool <select id="tool" aria-label="Tool">
            <option value="pen">Pen</option><option value="erase-parts">Erase parts</option>
            <option value="erase-strokes">Erase whole strokes</option><option value="pan">Pan board</option>
          </select></label>
          <label id="color-control">Ink <input id="color" type="color" value="#203b42" aria-label="Ink color"></label>
          <label id="width-control">Width <input id="width" type="range" min="1" max="12" value="3" aria-label="Pen width"></label>
          <label id="eraser-control" hidden>Size <input id="radius" type="range" min="3" max="50" value="12" aria-label="Eraser radius"></label>
          <label class="touch-label"><input id="touch" type="checkbox" checked> Finger drawing</label>
        </div>
        <div class="actions">
          <button id="undo" disabled>Undo</button><button id="clear" disabled>Clear page</button>
          <details class="export-menu"><summary>Export SQLite <span aria-hidden="true">↓</span></summary>
            <div class="export-options">
              <button id="export-full" disabled>Full history</button>
              <button id="export-visible" disabled>Visible state only</button>
              <p>Visible state keeps every page and drops earlier edits.</p>
            </div>
          </details>
        </div>
      </section>
      <div id="board-controls" class="board-controls" hidden>
        <span>Drag with Pan to explore the board.</span>
        <button id="zoom-out" aria-label="Zoom out">−</button>
        <button id="zoom-in" aria-label="Zoom in">+</button>
        <button id="home-view">Reset view</button><span id="view-position"></span>
      </div>
      <div class="page-heading"><span id="page-heading">UNTITLED / 01</span><span id="save-state" role="status">Loading</span></div>
      <div class="paper"><canvas id="canvas" aria-label="Drawing page"></canvas></div>
      <footer><span id="counts">Loading</span>
        <details id="diagnostics"><summary>Capture details</summary>
          <p>Pressure and contact size may be browser defaults. Hardware measurement support is unknown.</p>
          <pre id="sample-info">Draw a stroke to inspect its input.</pre>
        </details>
        <details class="local-state"><summary>Local state</summary>
          <button id="reset-settings">Reset local notebook</button>
        </details>
      </footer>
    </section>
    <section id="viewer-panel" hidden></section>
  </main>`;
}
