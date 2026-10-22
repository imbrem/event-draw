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
pnpm build           # type check + static bundle in dist/
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
finger drawing and Clear page. The bottom dock keeps the tools visible.

The tool buttons show the active tool and can be activated with a click,
tap, Space or Enter. Pan is available only on whiteboards. Tool changes are
disabled during contact and while an edit is being saved.

- **Pen** draws constant-width ink while retaining reported pressure and angles.
- **Erase parts** cuts paths geometrically, including crossings between samples.
- **Erase whole strokes** removes each visible shape touched by the eraser.
  A fragment left by a previous partial erase is its own visible shape.
- **Lasso select** selects ink enclosed by or touching the loop. Drag inside
  the selection's bounds to move the group, or use **Delete selected**.
  Move/delete each undo as one operation. **Deselect** lets you start a new
  loop inside the old selection. Selection is temporary and clears when
  changing page/tool; its input and shape references remain in full history.
- **Undo** reverses the last drawing edit on the active page. **Clear page**
  affects only that page. Document/page operations are not undoable yet. There is no redo.
- Add A4, Letter, landscape or square pages, or an **infinite whiteboard**.
  Whiteboards support Pan and zoom buttons, including negative coordinates.
  The view is temporary UI state; page content persists independently.
  Insert blank pages after the current page, move them earlier/later or delete
  them. Page numbers change; their IDs and annotations do not. A deleted page
  is hidden, with its captures/history retained in the full database. Keep at
  least one page per blank document. PDF page order/count follow the source.
- **Events** browses actual SQLite tables/views with pagination and decoded JSON.
  App events show their referenced shape states.
- **Raw strokes** displays capture records and a neutral geometry preview.
  It does not apply the shape's color, painted width, tool or placement.

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

See [src/schema.sql](src/schema.sql). The current schema version is 3.

| Table/view | Purpose |
| --- | --- |
| `stroke_events` | Immutable raw input gestures: ID, capture session, data version, observations JSON |
| `shapes` | Renderable geometry: ID, raw capture ID, fractional sample range |
| `styles` | Color and painted line width |
| `app_events` | Unified ordered operations: ID, edit time, kind, page, input/tool/style references |
| `app_event_shapes` | Complete shape visibility, page, style, offset and paint-order snapshots per edit |
| `latest_shape_states` | Each shape's newest state, ordered by app-event ID |
| `visible_shapes` | Current visible states joined to their geometry, style and raw input |
| `assets` | Content ID, media type, byte length and original PDF bytes |
| `documents` | Unique human name and optional PDF content reference |
| `pages` | Stable ID, document, one-based page number, source PDF page, dimensions/kind and deletion state |
| `capture_sessions` | Clock origin, browser/source and API exposure metadata |

**Raw capture IDs, shape IDs and app-event IDs are separate namespaces.** One
raw gesture can produce several derived shapes; many edits can reference a
shape. Retaining geometry while filtering out its historical creation event
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
eraser hides the touched shape and shows ranges of the same capture; fractional
range endpoints interpolate the measured polyline. No synthetic fragment
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
2. Visible shapes and their original IDs/ranges, referenced raw captures,
   capture sessions and styles.
3. One `history.baseline` event with the current placement and paint order.

The export verifies ordered render-input equality. It leaves the source
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
and all referenced resources. Future text state must also participate in
the baseline and equality check. SQLite-file import is not implemented yet; exports
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

To render a saved stroke, the app queries `visible_shapes`, chooses the
measured sample stream, clips it to the shape's sample range, adds its separate
placement offset, and draws it with Canvas 2D `moveTo`/`lineTo`/`stroke`. Color
and painted width come from the joined style. Round caps/joins connect the
segments; a circle covers single-point contacts. Canvas scaling accounts for
the page viewport and device pixel ratio. Live ink uses the same sample policy
and drawing primitive before the completed capture reaches SQLite.

There is currently no smoothing, curve fitting or pressure-dependent width.
Predictions are stored but excluded from measured ink. Those rendering choices
can evolve without rewriting the original capture.

Contacts commit at completion/cancellation. A crash during contact can lose
that in-memory capture. Failed writes stop new drawing and offer JSON recovery
of unsaved inputs; full SQLite export still covers saved records.

Browser observations are not unprocessed digitizer samples. Native capture
may expose additional measurements/corrections. Real iPad/unofficial-pencil
sampling, latency and palm rejection still need device testing. Text,
redo, synchronization and CAS integration remain future work.

## Code boundaries

| Module | Responsibility |
| --- | --- |
| `capture.ts`, `model.ts` | Browser snapshots, capture types and measured-sample/local-coordinate policy |
| `geometry.ts` | Pure path/range, erasing, lasso and selection calculations |
| `journal.ts`, `storage/` | Atomic app operations, SQLite queries and schema/reset |
| `database.ts`, `db.worker.ts` | Worker transport, WASM initialization and persistent storage |
| `pages.ts` | Page presets and disposable whiteboard viewports |
| `ui/tool-picker.ts`, `ui/shell.ts` | Tool-button component and page markup |
| `ui/page-navigation.ts`, `ui/notebook-location.ts` | Numbered navigation and disposable location preference |
| `ui/page-surface.ts` | Fit/zoom/layout and cancellable PDF background rendering |
| `pdf/source.ts`, `pdf/library.ts` | Content backend contract, URL reading, digest policy and PDF.js cache |
| `storage/documents.ts` | Document name/content index and page topology transactions |
| `ui/canvas.ts` | Pointer lifecycle, pointer capture and frame scheduling |
| `ui/drawing.ts`, `render.ts` | Shared Canvas primitives and notebook scene rendering |
| `ui/viewer.ts` | Read-only browsing and neutral raw previews |
| `app.ts` | State coordination, edit queue and control wiring |

Shared storage/codecs and
CAS abstractions can later move to Rust in covalence behind its TS/JS API;
versioned raw byte blobs can preserve floating-point observations independently
of float-free manifests.
