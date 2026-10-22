import { PAGE_PRESETS } from '../pages.ts';
import { undoIcon, redoIcon, notebooksIcon, composeIcon } from './icons.ts';

export function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error('Missing UI element: ' + id);
  return value as T;
}
export function mountShell() {
  element('app').innerHTML = `
  <header class="app-bar">
    <span class="mark" aria-label="Event Draw">e.</span>
    <button id="show-notebooks" title="Switch notebooks" aria-label="Notebooks">${notebooksIcon}<span id="active-notebook-name">Notebooks</span></button>
    <input id="document-title" aria-label="Document title" placeholder="Blank notes" autocomplete="off" maxlength="200">
    <nav id="page-navigation" aria-label="Page navigation"></nav>
    <span id="save-state" role="status">Opening…</span>
    <button id="new-writing-note" aria-label="New writing note" title="New writing note">${composeIcon}</button>
    <button id="return-notebook" hidden>Notebook</button>
    <details id="options" class="options-menu"><summary>Menu</summary>
      <div class="options-panel">
        <nav class="tabs" aria-label="Views">
          <button data-tab="notebook" aria-pressed="true">Notebook</button>
          <button data-tab="events" aria-pressed="false">Events</button>
          <button data-tab="raw" aria-pressed="false">Raw strokes</button>
        </nav>
        <section aria-label="Notebook files"><h2>Notebooks</h2>
          <label class="file-button">Import notebook <input id="notebook-file" type="file" accept=".sqlite3,.sqlite,.db,application/vnd.sqlite3"></label>
          <button id="new-notebook">New notebook</button><button id="restore-backup">Restore recovery copy</button>
          <p id="notebook-name">Local notebook</p><p>Saved locally as you work. Save SQLite to keep a portable notebook. Importing adds a separate copy to your library. Use Notebooks in the top bar to switch.</p>
        </section>
        <section aria-label="Documents"><h2>Document</h2>
          <label id="document-choice">Choose document <select id="document" aria-label="Document"></select></label>
          <label>Name <input id="document-name" aria-label="Document name" placeholder="Blank notes"></label>
          <button id="rename-document">Rename</button><label>New note layout <select id="new-document-layout"><option value="note">Growing canvas</option><option value="fixed">Fixed pages</option></select></label><button id="new-document">New blank document</button>
          <label class="file-button">Open PDF <input id="pdf-file" type="file" accept="application/pdf,.pdf"></label>
          <label><input id="insert-pdf" type="checkbox"> Insert PDF after current page</label>
          <label class="file-button">Add image / SVG <input id="image-file" type="file" accept="image/*,.svg"></label>
          <label><input id="image-as-object" type="checkbox"> Place image / SVG on current page</label>
          <form id="pdf-url-form"><label>PDF URL <input id="pdf-url" type="url" required placeholder="https://…"></label>
            <button id="import-url" type="submit">Import URL</button></form>
          <p id="document-hash" class="content-id"></p>
        </section>
        <section id="blank-page-controls" aria-label="Blank pages"><h2>Pages</h2>
          <label>New page <select id="page-size" aria-label="New page size">
            ${PAGE_PRESETS.map((p) => '<option value="' + p.id + '">' + p.label + '</option>').join('')}
          </select></label><button id="add-page">Insert page after this one</button>
          <div class="row"><button id="page-earlier">Move earlier</button><button id="page-later">Move later</button></div>
          <button id="delete-page">Delete page</button>
        </section>
        <section aria-label="Interface"><h2>Workspace</h2>
          <label>Writing view <select id="workspace-mode" aria-label="Writing workspace"><option value="auto">Automatic · Notes on touch devices</option><option value="notes">Notes · fill width</option><option value="page">Page · fit whole page</option></select></label>
          <button id="extend-note" hidden>Add writing space</button>
          <p>Notes fills the screen width. Pencil draws; fingers scroll unless Finger drawing is enabled. Use New writing note for a page that grows with your ink and text.</p>
          <h2>Toolbar</h2>
          <label>Layout <select id="toolbar-layout" aria-label="Toolbar layout"><option value="auto">Automatic</option><option value="notes">Notes</option><option value="full">Full</option><option value="minimal">Minimal</option></select></label>
          <label>Labels <select id="toolbar-labels" aria-label="Toolbar labels"><option value="auto">Automatic</option><option value="icons">Icons only</option><option value="labels">Show labels</option></select></label>
          <div id="more-tools" class="tool-picker" role="group" aria-label="More tools" hidden></div>
          <div id="toolbar-overflow" class="toolbar-overflow" hidden></div>
        </section>
        <section id="installable-app" aria-label="App installation"></section>
        <section><h2>Export & local state</h2>
          <details class="export-menu"><summary>Export SQLite ↓</summary><div class="export-options">
            <button id="export-full">Save notebook · full history</button><button id="export-visible">Visible state + provenance</button><button id="export-drawn">Just what’s drawn</button>
            <label><input id="include-blobs" type="checkbox" checked> Embed source files</label>
            <button id="export-pdf">Annotated PDF · current document</button>
            <button id="export-jsonl">Raw event stream · JSONL</button>
            <label class="file-button">Reconstruct from JSONL <input id="jsonl-file" type="file" accept=".jsonl,.ndjson,application/x-ndjson"></label>
            <p id="replay-report" role="status"></p>
            <p>SQLite includes all documents. Drawn state excludes linked notes and diagnostic detections. PDF export flattens backgrounds, ink and page objects.</p>
          </div></details>
          <p id="storage" role="status">Opening notebook…</p>
          <p id="counts"></p><p id="page-heading"></p>
          <details id="diagnostics"><summary>Capture details</summary>
            <p>Pressure and contact size may be browser defaults.</p><pre id="sample-info">Draw a stroke to inspect its input.</pre>
          </details>
          <details class="local-state"><summary>Local state</summary><button id="reset-settings">Reset local notebook</button></details>
        </section>
      </div>
    </details>
  </header>
  <div id="frontend-extensions" hidden></div>
  <div id="notice" role="status" hidden></div>
  <div id="recovery-actions" hidden><button id="export-existing">Export existing SQLite</button><button id="reset-local">Reset local notebook</button></div>
  <button id="recover" hidden>Export unsaved input (JSON)</button>
  <main>
    <section id="notebook-panel">
      <div class="notebook-workspace"><div id="page-viewport" class="page-viewport"><div class="page-frame">
        <div id="paper" class="paper"><canvas id="pdf-canvas" aria-label="PDF page background" hidden></canvas><canvas id="canvas" aria-label="Drawing page"></canvas><div id="page-objects" class="page-objects"></div><div id="pdf-text" class="pdf-text" hidden></div></div>
      </div></div><aside id="text-panel" aria-label="Page text notes" hidden></aside></div>
      <div id="drawing-toolbar" class="ink-dock" aria-label="Drawing tools">
        <div id="tool-picker" data-toolbar-section="tools" class="tool-picker" role="group" aria-label="Tools"></div>
        <div class="history-controls" data-toolbar-section="history">
          <button id="undo" disabled aria-label="Undo" title="Undo (⌘/Ctrl+Z)" aria-keyshortcuts="Meta+Z Control+Z">${undoIcon}<span class="toolbar-label">Undo</span></button>
          <button id="redo" disabled aria-label="Redo" title="Redo (⌘/Ctrl+Shift+Z or Ctrl+Y)" aria-keyshortcuts="Meta+Shift+Z Control+Shift+Z Control+Y">${redoIcon}<span class="toolbar-label">Redo</span></button>
        </div>
        <button id="browse-pages" data-toolbar-section="pages">Pages / Search</button>
        <button id="toggle-text" data-toolbar-section="notes" aria-expanded="false" aria-controls="text-panel">Notes</button>
        <div id="paint-toolbar" data-toolbar-section="color" class="paint-toolbar"><div id="color-palette" class="color-palette"></div>
          <label id="color-control" title="Custom ink color"><input id="color" type="color" value="#203b42" aria-label="Ink color"></label></div>
        <div id="thickness-controls" data-toolbar-section="thickness" class="thickness-controls">
          <label id="width-control"><span id="width-label">Width</span><span id="width-preview" class="thickness-preview" aria-hidden="true"></span><input id="width" type="range" min="1" max="32" step="0.5" value="3" aria-label="Pen width"><output id="width-value" for="width"></output></label>
          <label id="eraser-control" hidden>Size <span id="radius-preview" class="thickness-preview eraser-preview" aria-hidden="true"></span><input id="radius" type="range" min="6" max="100" value="24" aria-label="Eraser size"><output id="radius-value" for="radius"></output></label>
        </div>
        <details id="ink-settings" data-toolbar-section="advanced"><summary>Ink & actions</summary><div class="ink-settings-panel">
          <div id="ink-policies"></div>
          <label>Lasso <select id="lasso-policy" aria-label="Lasso policy"></select></label>
          <label><input id="touch" type="checkbox" checked> Finger drawing</label>
          <label><input id="show-boxes" type="checkbox" checked> Show detected boxes</label>
          <label><input id="select-pdf-text" type="checkbox"> Select PDF text</label>
          <button id="clear">Clear ink</button>
        </div></details>
        <div class="zoom-controls" data-toolbar-section="zoom"><button id="zoom-out" aria-label="Zoom out">−</button><button id="zoom-in" aria-label="Zoom in">+</button><button id="home-view">Fit page</button></div>
      </div>
      <div id="selection-controls" class="selection-controls" hidden>
        <span id="selection-count">0 selected</span><button id="delete-selection">Delete selected</button><button id="deselect">Deselect</button>
        <button id="apply-processing">Apply ink policies</button>
        <button id="copy-selection">Copy</button><button id="paste-selection">Paste</button><button id="duplicate-selection">Duplicate</button>
        <button id="shrink-selection">Smaller</button><button id="grow-selection">Larger</button><button id="rotate-selection">Rotate 15°</button>
        <span>Loop to select. Drag inside the selection to move.</span>
      </div>
      <div id="board-controls" hidden><span id="view-position"></span></div>
    </section>
    <section id="viewer-panel" hidden></section>
    <dialog id="notebook-library" aria-label="Notebook library"></dialog>
    <dialog id="page-browser" aria-label="Pages and search"></dialog>
  </main><footer id="status-indicators" class="status-indicators" aria-label="Notebook indicators"></footer>`;
}
