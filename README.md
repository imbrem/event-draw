# Event Draw

A small browser notebook with raw pointer capture, a SQLite edit journal,
PDF annotation, multiple documents/pages, vector erasers, and an inspectable event database. No account,
server, native wrapper, or covalence dependency yet.

## Run

Node 24+ and pnpm:

```sh
pnpm install
pnpm dev
```

Open http://localhost:5173. Draw with a mouse, pen, or finger. Turn off
**Finger drawing** when using a pen; this is an input filter, not full palm
rejection. On a tablet, use a trusted HTTPS origin for persistent storage.
Plain LAN HTTP cannot provide browser filesystem storage; where supported,
the app uses an explicitly labelled temporary database. Export before closing.
HTTPS hosting/tunnelling is not configured here.

The notebook belongs to this browser profile and origin (including port).
One tab owns it at a time; another tab is blocked with instructions to close
the owner and reload. Browser storage can be evicted; export files to keep them.

**Menu → Local state → Reset local notebook** deletes local documents, PDFs,
pages, captures and history after confirmation. An incompatible schema shows **Export existing
SQLite** and **Reset local notebook** even when the notebook cannot initialize.
There are no migrations or silent resets during this prototype's rapid iteration.
Reset affects only this app's database at the current origin.

```sh
pnpm build           # type check + static app and reusable core in dist/
pnpm build:core      # only the DOM-free JS library and TypeScript declarations
pnpm preview         # serve the built app on localhost:4173
pnpm test            # Node SQLite, capture, geometry and schema tests
pnpm exec playwright install webkit  # once, for Safari-engine tests
pnpm test:browser    # installed Chrome + Playwright WebKit; start dev first
```

Browser tests use isolated profiles, including a temporary on-disk WebKit
profile because ephemeral WebKit contexts do not support OPFS. SQLite WASM
runs in a worker with OPFS SAH-pool persistence. No special HTTP headers are
needed for this VFS. Runtime assets are served locally; no CDN is needed.

## Notebook and database viewers

The page uses the available window. Choose a document in the top bar and use
previous/next, or enter a page number. **Fit page** restores the whole-page view;
zooming a finite page makes it scrollable. The current document/page is a
disposable local preference, restored after reload. Navigation is a separate
component so a scrolling layout or page picker can replace it later.

**Menu** contains document/PDF management, blank-page controls, database viewers,
exports and storage diagnostics. **Ink & actions** contains style, eraser size,
finger drawing, processing policies and Clear ink. The bottom dock keeps the tools visible.

The tool buttons show the active tool and can be activated with a click,
tap, Space or Enter. Pan is available only on whiteboards. Tool changes are
disabled during contact and while an edit is being saved.

- **Pen** draws pressure-dependent ink when valid pen pressure is available.
  Mouse/touch or missing/invalid pressure uses the base width. Pen-up zero
  carries the preceding pressure instead of creating an artificial taper.
- **Highlighter** remembers its own color/width and paints translucent ink
  (28% opacity). Each contact is filled once, so overlapping samples within
  that contact do not darken it; separate contacts do. It uses source-over
  compositing on the ink overlay, including over PDFs.
- **Restyle on touch** applies the current color/base width to touched shapes.
  It preserves their IDs, raw captures, processing outputs and placement;
  the whole contact undoes as one edit. This is a declarative touch plugin.
- **Erase parts** cuts paths geometrically, including crossings between samples.
- **Erase whole strokes** removes each visible shape touched by the eraser.
  A fragment left by a previous partial erase is its own visible shape.
- **Lasso select** selects ink enclosed by or touching the loop. Drag inside
  the selection's bounds to move the group, or use **Delete selected**.
  Move/delete each undo as one operation. **Deselect** lets you start a new
  loop inside the old selection. Selection is temporary and clears when
  changing page/tool; its input and shape references remain in full history.
  Choose the lasso policy under Ink & actions. **All vertices inside** tests
  output centerline vertices; a sparse segment may leave a concave loop.
  **Apply ink policies** reprocesses the selected group as one undoable edit.
- **Undo** reverses the last ink or saved text edit on the active page.
  **Clear ink** affects only that page's ink. Document/page operations are
  not undoable yet. There is no redo.
- **Text** opens the page's Markdown source and rendered preview, including
  inline LaTeX between `$…$` via locally bundled KaTeX. Source autosaves after
  600 ms; navigation and exports flush drafts. Each save creates an immutable
  revision in the same app-event stream. Text is a page-attached note in a
  side panel, not a positioned canvas object or WYSIWYG editor. HTML is escaped,
  remote images disabled, and TeX is rendered without trusted commands.
- Add A4, Letter, landscape or square pages, or an **infinite whiteboard**.
  Whiteboards support Pan and zoom buttons, including negative coordinates.
  The view is temporary UI state; page content persists independently.
  Insert blank pages after the current page, move them earlier/later or delete
  them. Page numbers change; their IDs and annotations do not. A deleted page
  is hidden, with its captures/history retained in the full database. Keep at
  least one page per blank document. PDF page order/count follow the source.
- **Events** browses actual SQLite tables/views with pagination and decoded JSON.
  App events show their referenced shape states.
- **Raw strokes** displays capture records alongside a stored processing output.
  Both previews use neutral color/base width, without fragment erasing or
  placement. **Try a processor on this trace → Preview policies** compares
  experimental smoothing/pressure/rejection without saving anything. Older
  stored outputs remain selectable after reprocessing.
  **Replay stroke** animates the measured samples at their recorded timing,
  with 0.25×, 1× or 4× speed and Stop. Missing sample clocks fall back to receipt
  clocks; regressions clamp forward and zero-duration captures appear instantly.
  Predictions stay excluded. Replay is display-frame limited and does not write
  to the database. Original and processed geometry replay together using the
  raw sample clock and saved source correspondence. Replay stops when changing
  rows, refreshing or leaving the viewer.

Both database viewers include **Database diagnostics**, covering all documents:
ink captures with any visible geometry, all raw captures used by visible ink,
visible/total shapes, event/effect counts, document/page counts and JSON/PDF
payload sizes. Visibility means *any fragment remains*, not a fraction of path
length. Eraser/lasso/move/cancelled inputs contribute to the raw denominator,
while ink captures are raw IDs referenced by shapes. Compaction changes the
historical denominators. Empty denominators show n/a. **Refresh database**
updates the aggregates and rows on demand; the raw table itself is unchanged.

## Testing on a tablet

No macOS update, Xcode or developer membership is needed for the browser app.
Desktop Chrome and WebKit tests cover the database, geometry, imports, rendering
and UI, but cannot establish real pencil sampling, latency, palm rejection,
tablet memory limits, Safari storage eviction or background/resume behavior.
An unofficial pencil may report a finger or fixed/default pressure. The raw
viewer and capture-session capability metadata help distinguish observations
from actual hardware support; an exposed field is not proof of a measurement.

For a quick drawing-only check, open `http://<Mac-LAN-IP>:5173` on the same Wi-Fi
while `pnpm dev` runs. macOS may request firewall access. LAN HTTP may require
session-only storage; export before closing. For a meaningful persistence test,
use a trusted HTTPS URL. One convenient temporary option is Cloudflare's quick
tunnel to a **static build**, with no Apple tooling:

```sh
brew install cloudflared             # once, if needed
pnpm build
python3 -m http.server 8080 --bind 127.0.0.1 --directory dist
```

In another terminal:

```sh
cloudflared tunnel --url http://127.0.0.1:8080
```

Open the printed `https://…trycloudflare.com` URL in Safari on the iPad/iPhone.
This exposes the built app to anyone with the URL until the tunnel is stopped;
notes/PDFs remain in that device's browser storage, without a sync server.
Quick-tunnel URLs change between runs, and each new origin gets separate browser
storage, so export before stopping. Use a stable HTTPS origin for continued work.
This repo does not automatically install or start an external tunnel.

Try fast/slow curves, taps, pressure/tilt changes and a palm resting on the page;
inspect the raw JSON and replay. Turn off Finger drawing and check whether your
pencil still works. Test both erasers, lasso/move/undo, portrait/landscape rotation,
a small multipage PDF, reload, background/resume and both SQLite exports. Check
that storage says **Stored on this device**, then reopen the *same* HTTPS URL.
The same workflow applies after a macOS update. Xcode is needed later for a native
wrapper/capture bridge; Safari's Develop menu can already inspect a USB-connected
iPad when Web Inspector is enabled on the device.

## PDFs, document names and content storage

Use **Menu → Open PDF** for a file, or enter an HTTP(S) **PDF URL → Import URL**.
URL imports require the remote server to allow CORS; there is no proxy. A failed
import leaves the notebook usable. Imports are limited to 200 MiB and read the
whole file into memory. Password-protected PDFs are not supported yet.

The importer computes `sha256:<hex>` from the original file bytes. SQLite's
`assets` table stores those exact bytes once, and `documents` maps a unique
human name to the PDF hash. Reopening the same PDF selects its existing document
and annotations. Renaming a document changes neither hash nor page IDs. The
empty-name default document has no PDF; additional blank documents can be created.
Names cannot contain `/`, leaving a human address such as `Paper/2` or `/1`.
Use document/page IDs internally: names and page positions are mutable.

PDF.js renders the source as a separate canvas beneath the ink. Each PDF page
uses its default rotated/cropped viewport dimensions in PDF points; the ink and
background share that coordinate space and CSS size. Zoom/DPR change rendering
resolution, not stored coordinates. The original PDF is unchanged. SQLite
exports include the PDF and annotation overlay; **annotated-PDF export**, text
selection, interactive links/forms and password prompts are not implemented.

`pdf/library.ts` depends only on `PdfSource.read(contentId): Promise<Uint8Array>`
from `pdf/source.ts`. The current implementation is `DatabaseClient.read`, backed
by SQLite in the worker. Replace the injected source to read from another CAS
without changing PDF rendering or navigation. Current SHA-256 IDs are verified
on import/read. Other future CID schemes must be verified by their backend.

**TODO: covalence** should supply arbitrary CIDs, codecs and digest algorithms,
including BLAKE3, through its Rust/TS API. Verified range reads also need a
chunk/tree layout and proofs; a whole-file digest alone does not authenticate
individual byte ranges. No BLAKE3, range fetching or covalence integration is
implemented in this prototype. PDF.js fonts/decoders/worker are bundled locally.

## Identity and schema

See [src/schema.sql](src/schema.sql). The current schema version is **4**.
Earlier notebooks require export/reset; no backward migration is provided.

| Table/view | Purpose |
| --- | --- |
| `stroke_events` | Immutable raw input gestures: ID, capture session, data version, observations JSON |
| `ink_policies` | Immutable versioned smoothing, pressure and rejection configuration |
| `ink_outputs` | Immutable processed geometry, raw capture/policy references and separate rejection reason |
| `shapes` | Geometry instances: ID, output ID, fractional output-vertex range |
| `styles` | Color, base line width, opacity and blend mode |
| `app_events` | Unified ordered operations: ID, edit time, kind, page, input/tool/style/policy references |
| `app_event_shapes` | Complete shape visibility, page, style, offset and paint-order snapshots per edit |
| `latest_shape_states` | Each shape's newest state, ordered by app-event ID |
| `visible_shapes` | Current visible states joined to their geometry, style and raw input |
| `assets` | Content ID, media type, byte length and original PDF bytes |
| `documents` | Unique human name and optional PDF content reference |
| `pages` | Stable ID, document, one-based page number, source PDF page, dimensions/kind and deletion state |
| `capture_sessions` | Clock origin, browser/source and API exposure metadata |
| `text_contents` | Immutable format/source revisions; arbitrary format tags for future renderers |
| `app_event_texts` | Page/content effects, with NULL content meaning clear |
| `visible_texts` | Current text source per active page |

**Raw capture IDs, output IDs, shape IDs and app-event IDs are separate namespaces.**
One raw gesture can have many processing outputs; one output can have several
shape instances/fragments; many edits can reference a shape. Retaining geometry
while filtering out its historical creation event
does not change its identity. These integer IDs are local to a database, not
global synchronization IDs.

A raw row represents an entire real contact, including erasing and cancelled
contacts, not one pointer callback. Its JSON contains only observations:
reported/coalesced/predicted deliveries, sample/receipt clocks, original browser
measurements and coordinate transforms. No app tool, paint style, page ID,
wall-clock edit time, or render placement is stored in the raw row.
**Sample `width`/`height` mean sensor contact dimensions**, not painted width.
Raw `pointerType`, `button` and `buttons` are browser measurements, distinct
from the selected app tool.

Render x/y coordinates are relative to the first measured sample; the initial
page offset lives in the referencing app state. Original client/page/screen
coordinates remain as reported. A shape can therefore move without rewriting
its raw capture, and several shape instances can share a raw ID. A partial
eraser hides the touched shape and shows ranges of the same output; fractional
range endpoints interpolate its geometry and width factors. No synthetic fragment
observations are inserted into the raw table.

Lasso and move contacts are also real raw capture rows. `selection.lasso`
references the selected shape states without changing their placement;
`selection.move` writes new offsets for the same shape IDs, and
`selection.delete` hides those instances. The current selection itself is
UI state and is not restored by reload or undo.

App events have relational foreign keys for resources and undo references;
shape effects have foreign keys and complete state columns. Kind/version and
operation-specific metadata are columns where useful; extensible event JSON
is available for later text/document operations. A single transaction commits
the capture, semantic edit and all shape effects. Undo appends inverse states;
raw captures and prior operations are never rewritten by drawing edits.
Document names and page topology are current-state projections with changes
recorded in this same app-event stream; topology is not rebuilt by shape undo.

```sql
SELECT * FROM visible_shapes ORDER BY paint_order, id;
```

Latest state uses event ID, not wall-clock time. Paint order is explicit;
shape ID breaks ties deterministically. Pages share one app-event stream,
while placement and page-local editing keep their rendered content separate.

## Filtering history without changing rendering

**Export SQLite → Full history** exports the journal. **Visible state only**
builds a new database containing:

1. All document names, byte-identical PDF assets and page definitions, including
   empty/deleted pages and unbounded boards.
2. Visible shapes and their original IDs/ranges, required outputs/policies,
   raw captures, capture sessions, styles and visible text contents.
3. One `history.baseline` event with current shape and text effects.

The export verifies ordered shape render-input and visible text equality. It leaves the source
unchanged, drops prior undo history, and allows subsequent edits/undo in the
new database. When a visible fragment references a raw capture, that whole
capture remains: compaction removes irrelevant edit history, not portions of
sensor data inside a retained dependency.

```sh
pnpm compact event-draw-full.sqlite3 current-state.sqlite3
sqlite3 current-state.sqlite3 'SELECT id, raw_stroke_id, page_id, offset_x, offset_y FROM visible_shapes;'
sqlite3 current-state.sqlite3 'PRAGMA foreign_key_check; PRAGMA integrity_check;'
```

The CLI refuses to overwrite an existing output and accepts only the current
schema. Arbitrarily deleting historical events is unsafe: deleting a hide can
resurrect a shape. Retaining a suffix later will need a baseline at the cutoff
and all referenced resources. SQLite-file import is not implemented yet; exports
can be inspected and processed with ordinary SQLite tools.

## Capture behavior and limits

The browser supplies **Pointer Events**, not complete stroke objects. The
capture adapter snapshots their relevant fields into plain JSON, retaining
each delivered event and separate coalesced/predicted batches. It also adds
receipt time and derived local coordinates/transforms; original browser
coordinates and pen measurements remain as reported. This is a structured
capture of browser observations, not a verbatim serialization of DOM objects.

- Snapshot values immediately in each callback. Preserve delivered events and
  separate coalesced/predicted lists, plus raw updates when the browser emits them.
- Render raw-update observations when present; otherwise render coalesced
  observations, falling back to the delivered sample. Keep overlapping
  pointermove deliveries for analysis. Predictions remain stored but do not
  become measured ink.
- Preserve pressure, tilt, twist, angles, contact dimensions, IDs, buttons,
  coordinates, transforms and clocks. Missing numeric fields become `null`;
  reported zeros/defaults remain. API exposure does not establish hardware
  support: pressure may be a browser default such as 0.5.
- Sample time is the original `PointerEvent.timeStamp`; receipt time uses
  `performance.now()`, relative to the capture session's time origin.
  App edit wall time lives in `app_events.occurred_at`.
- Geometry uses page units; original browser coordinates/contact dimensions
  retain CSS pixels. Tilt/twist use degrees, altitude/azimuth radians, and
  pressure the browser's reported normalized value.
- Cancelled contacts are captured and referenced by `input.cancel`, with no
  visible shape change. Unsupported raw data versions remain stored but are
  skipped by this renderer.

To render saved ink, the app queries `visible_shapes`, clips the **baked output**
to the instance's vertex range, adds placement, and fills a Canvas 2D path
containing variable-radius discs and tangent hulls. Vertex `widthFactor` times
the style's base width gives painted width. This standard geometry renders
without installing or rerunning the processor that created it. Canvas scaling
accounts for viewport and device pixel ratio. Live ink uses the same processing
pipeline and drawing primitive before the completed capture reaches SQLite.
Predictions remain stored and excluded from measured ink.

Contacts commit at completion/cancellation. A crash during contact can lose
that in-memory capture. Failed writes stop new drawing and offer JSON recovery
of unsaved inputs; full SQLite export still covers saved records.

Browser observations are not unprocessed digitizer samples. Native capture
may expose additional measurements/corrections. Real iPad/unofficial-pencil
sampling, latency and palm rejection still need device testing. Redo,
synchronization and CAS integration remain future work.

## Processing experiments and reusable plugins

The data flow is `raw capture → versioned policy → immutable ink output → shape
instance + style + placement`. Output JSON contains only `kind: "ink-path"`
and vertices `{x, y, sourceIndex, widthFactor}`. Color, base width, opacity,
tool, edit time and rejection reason stay outside it. `sourceIndex` maps each
vertex to a fractional position in the measured sample stream for replay and
reprocessing fragments. It must increase strictly; processors that reorder or
combine contacts need a different output schema.

`InkProcessors` accepts replaceable smoothing, pressure and whole-contact
rejection stages. Built-ins include no smoothing, moving average, constant
width, pen pressure, accept-all and pen-only. They are deterministic functions
over copied observations. Output validation rejects invalid correspondence,
nonfinite geometry and invalid width factors. An exception or malformed output
persists an empty rejected result with diagnostics, keeping the raw contact.
Whole-contact rejection is not a complete palm rejection system; the existing
Finger drawing input filter still discards touch before capture when disabled.

The policy identifies **exact immutable implementations** and options. Outputs
deduplicate by raw capture/policy. Register a changed implementation with a new
version or code CID; the registry refuses to replace an existing ID. Reprocessing
creates new outputs/instances and appends visibility effects, preserving the old
versions for inspection and undo. It maps retained fragment endpoints through
raw sample correspondence, avoiding restoration of erased source intervals.

The shared factory in `ink.ts` is used by both live rendering and the DB worker;
register new implementations there for notebook experiments. Policy controls
automatically list registered stages. For example:

```ts
const processors = createInkProcessors();
processors.smoothers.set('research/identity@2', ({ samples }) =>
  samples.map(({ x, y }, sourceIndex) => ({ x, y, sourceIndex })));
// Supply this registry to Journal(db, processors), or process a trace directly.
```

`InteractionPolicies` similarly injects lasso algorithms and touch transformers.
Lassos return shape IDs; touch plugins return style edits. The journal filters
targets to visible shapes on the current page, then owns transactions and undo.
These are trusted application plugins, not executable code from a notebook file.

`pnpm build:core` emits ESM and declarations without the UI or browser database
worker. The package exposes `event-draw/core` (Journal, SQL adapter interface,
capture model, processing, interactions, geometry, replay and transformation
types) and `event-draw/schema.sql`. Supply a synchronous SQLite adapter; no
particular web framework or SQLite runtime is required. The schema is an SQL
asset, so a browser host can import it with its bundler's raw-text mechanism.

An autoresearch loop can assign each edited implementation a fresh code CID,
evaluate fixed raw captures, preview candidates and explicitly apply a winner.
Keep the corpus, options, outputs and evaluation results tied to that identity.
Dynamic WASM loading, a job runner, persisted evaluation scores and model-driven
editing are **not implemented**. A future WASM host should run in an isolated
worker with cancellation and time/memory budgets; today's synchronous trusted
JS callbacks cannot be preempted if they hang.

## Fusion, recognition and drawing-to-math

Keep real contacts immutable. Fuse traces as a new **multi-input artifact** with
ordered source references, ranges, placements and provenance. Preserve pen-up
boundaries and clocks. Geometric grouping need not invent a continuous raw
contact; a recognizer can consume the same group without geometric fusion.

`transformations.ts` defines a future async host contract with an exact
implementation CID, multiple artifact inputs and typed-by-kind outputs. It is
a contract only: multi-input artifact persistence/execution, fusion UI, AI
recognition and a handwritten calculator are not implemented. The single-trace
`ink-path` table remains small and concrete until those semantics are exercised.

For a calculator, the reusable pipeline would be: select/group traces →
recognize a mathematical AST with source provenance → resolve an explicit
variable environment → evaluate → attach a result artifact and its display.
Then `x = 5` supplies a binding and a tool/gesture on `2x =` requests `10`.
Keep recognition alternatives and corrections separate from evaluation. Use
LaTeX as a display/export representation; diagram recognition should also
produce a graph with ports/topology for commutative and string diagrams.
Lean or another prover can consume a later symbolic elaboration stage with
recorded assumptions and validation results, independently of the drawing UI
or choice of model/provider.

## Remaining Notes functionality

The prototype covers the basic handwriting/PDF annotation loop, selection,
moving, erasing and page-attached formatted text. Reaching the important parts
of a daily notes app still needs real-device latency/palm/pinch tuning, redo,
positioned rich text and images, search/organization, reliable file import,
annotated PDF export and backup/sync. Recognition, collaboration and a native
capture bridge are separate larger projects. There is no meaningful completeness
percentage before choosing which of these workflows matters most.

## Code boundaries

| Module | Responsibility |
| --- | --- |
| `capture.ts`, `model.ts` | Browser snapshots, capture types and measured-sample/local-coordinate policy |
| `ink.ts`, `plugins.ts`, `storage/ink-store.ts` | Versioned processing stages, validated baked outputs and immutable identities |
| `interactions.ts`, `transformations.ts`, `core.ts` | Lasso/touch policies, future multi-input protocol and reusable entry point |
| `geometry.ts` | Pure path/range, erasing, lasso and selection calculations |
| `journal.ts`, `storage/` | Atomic app operations, SQLite queries and schema/reset |
| `database.ts`, `db.worker.ts` | Worker transport, WASM initialization and persistent storage |
| `pages.ts` | Page presets and disposable whiteboard viewports |
| `ui/tool-picker.ts`, `ui/shell.ts` | Tool-button component and page markup |
| `ui/ink-controls.ts` | Registry-driven policy controls and separate pen/highlighter paint preferences |
| `text.ts`, `storage/text-store.ts`, `ui/text-editor.ts` | Pluggable text rendering, immutable revisions and autosaved page drafts |
| `ui/page-navigation.ts`, `ui/notebook-location.ts` | Numbered navigation and disposable location preference |
| `ui/page-surface.ts` | Fit/zoom/layout and cancellable PDF background rendering |
| `pdf/source.ts`, `pdf/library.ts` | Content backend contract, URL reading, digest policy and PDF.js cache |
| `storage/documents.ts` | Document name/content index and page topology transactions |
| `ui/canvas.ts` | Pointer lifecycle, pointer capture and frame scheduling |
| `ui/drawing.ts`, `render.ts` | Shared Canvas primitives and notebook scene rendering |
| `ui/viewer.ts` | Read-only browsing and neutral raw previews |
| `storage/diagnostics.ts`, `ui/database-diagnostics.ts` | On-demand database aggregates and their labelled display |
| `replay.ts`, `ui/stroke-preview.ts` | Measured-sample timeline, neutral replay and cancellation |
| `app.ts` | State coordination, edit queue and control wiring |

Shared storage/codecs and
CAS abstractions can later move to Rust in covalence behind its TS/JS API;
versioned raw byte blobs can preserve floating-point observations independently
of float-free manifests.
