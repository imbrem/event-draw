# Feature reference

See the [project README](../README.md) for setup and the [architecture](README.md) for current identities and exchange APIs.

A small browser notebook with raw pointer capture, a SQLite edit journal,
mixed PDF/image/SVG annotation, positioned text/math, pluggable trace processing and box detection,
multiple documents/pages, vector erasers, and an inspectable event database. No account,
server, native wrapper, or covalence dependency yet.

## Run

Node 24+ and pnpm:

```sh
pnpm install
pnpm dev
```

Open http://localhost:5173. Draw with a mouse, pen, or finger. Turn off
**Finger drawing** to use one finger for panning. Two fingers pan/pinch; pen contact suppresses
touch, with a short guard after pen-up. This is heuristic palm filtering, not native digitizer rejection. On a tablet, use a trusted HTTPS origin for persistent storage.
Plain LAN HTTP cannot provide browser filesystem storage; where supported,
the app uses an explicitly labelled temporary database. Export before closing.
The internal deployment below provides a stable HTTPS origin.

Each exported SQLite file is a notebook. The app autosaves one working copy in this browser
profile and origin (including port). **Menu → Open notebook**, **New notebook**, and
**Save notebook · full history** open/create/download portable files. Opening a file replaces
the working copy; later edits do not automatically overwrite that original download. Notebook
imports require the current schema, validate structure/integrity/geometry/content hashes, and
replace saved state transactionally. A failed import preserves the working notebook.

Before opening/creating a notebook, the app retains a recovery copy. It also keeps up to three
idle snapshots, checked every minute; **Restore recovery copy** opens the latest. Recovery
uses IndexedDB separately from the OPFS working copy; if recovery storage is unavailable when
replacing a notebook, the previous notebook is downloaded instead. Browser-local copies can
all be lost together; downloaded SQLite files are the portable backup.

The working notebook belongs to this browser profile and origin.
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

## Internal deployment

Open https://sturdy-bassoon-w9lk351.pages.github.io/ on your Mac or in Safari on
your iPad/iPhone. Sign in to GitHub with an account that can read
`hiloopai/event-draw` (complete organization SSO if prompted). This Pages site
is private, with HTTPS enforced; repository privacy alone would not guarantee
private Pages access.

Start with **Menu → Open PDF**, or draw on the blank page. **Insert text** adds positioned
Markdown/math, and **Pages / Search** opens the page browser. Check that storage
says **Stored on this device**. If an old schema is rejected, export the existing
SQLite file and use **Reset local notebook**; this prototype has no migrations.

Notebooks and imported source files stay in that browser's local storage. Deployment
does not add synchronization or upload notebooks to GitHub. To transfer work between
devices, use **Save notebook · full history**, then **Menu → Open notebook** on the
other device. Embedded PDF/image/SVG blobs are included by default. Localhost and
the Pages site have separate working copies.

[The CI workflow](../.github/workflows/pages.yml) runs unit tests, type checking/build
and the browser suite in Chromium and WebKit on pull requests and pushes to `main`.
Browser checks use the production build at `/event-draw/`, including workers and
WASM, to exercise project-path asset resolution. CI starts its own preview server;
local browser checks use the already-running dev/preview server. Use a trailing slash
when setting `TEST_BASE_URL` to a subpath.

After checks pass on `main`, CI reads the configured private Pages URL, builds for
its actual base path, and deploys via the `github-pages` environment. That environment
allows only `main`; the workflow verifies `public: false` and never automatically
enables a missing Pages site. Manual redeployment is available through
**Actions → Check and deploy private Pages → Run workflow** on `main`.
The workflow uses the built-in `GITHUB_TOKEN`, without a stored deployment secret.

## Notebook and database viewers

The page uses the available window. Edit the document title in the top bar; choose another document in Menu and use
previous/next, or enter a page number. **Fit page** restores the whole-page view;
zooming a finite page makes it scrollable. The current document/page is a
disposable local preference, restored after reload. Navigation is a separate
component independent of the picker/reader. **Pages / Search** has lazy page thumbnails,
a continuous scroll reader (choose a page to edit), and search across text objects, linked
notes and available PDF text in this notebook. Handwriting is not searched yet.

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
  Move/delete each undo as one operation. Copy/paste/duplicate uses an ink clipboard within
  this tab, including between opened notebooks. Smaller/Larger and Rotate change placement
  on the same shape IDs; style and raw captures remain separate. **Deselect** lets you start a new
  loop inside the old selection. Selection is temporary and clears when
  changing page/tool; its input and shape references remain in full history.
  Choose the lasso policy under Ink & actions. **All vertices inside** tests
  output centerline vertices; a sparse segment may leave a concave loop.
  **Apply ink policies** reprocesses the selected group as one undoable edit.
- **Undo / Redo** reverse/reapply edits in the current document in journal order, including
  ink, saved content, page insertion/reordering/deletion and document naming. Editing after
  undo clears that document's redo branch. **Clear ink** affects only the current page.
  Keyboard: Cmd/Ctrl-Z, Shift-Z/Y, C/V/D for ink, A for all page ink, S to save SQLite,
  Delete/Backspace for selected ink, and Page Up/Down. Text fields keep native shortcuts.
- **Insert text** (or **Text → Add page text**) creates a positioned Markdown object, including
  inline LaTeX between `$…$` via locally bundled KaTeX. **Add linked note**
  creates content attached to the page without painting it. Each page can have
  several of either kind; the object picker switches between them. Source
  autosaves after 600 ms; navigation and exports flush drafts. Each save creates
  an immutable revision in the same app-event stream. Numeric placement controls
  set position, dimensions and angle; **Show on page** toggles rendering.
  `math/latex` renders display math. HTML is escaped, remote images disabled,
  and TeX is rendered without trusted commands. This is a source editor with
  previews, not WYSIWYG. With the text panel open, page objects expose Move, Resize
  and Rotate handles. A completed drag appends one object edit; cancellation restores it.
- **Show detected boxes** under Ink & actions toggles translucent, rotated
  rectangle overlays. With Lasso active, tap a box label to select its constituent
  ink shapes. The baseline script recognizes closed outlines from one or several
  intact contacts; see the detection section for its deliberately limited scope.
- Add A4, Letter, landscape or square pages, or an **infinite whiteboard**.
  Whiteboards support Pan and zoom buttons, including negative coordinates.
  The view is temporary UI state; page content persists independently.
  Insert blank pages after the current page, move them earlier/later or delete
  them. Page numbers change; their IDs and annotations do not. A deleted page
  is hidden, with its captures/history retained in the full database. Keep at
  least one page per document. Blank, PDF, raster-image and SVG pages may be inserted,
  reordered or deleted in any document, regardless of its original source.
- **Events** browses actual SQLite tables/views with pagination and decoded JSON.
  App events show their referenced shape states.
- **Raw strokes** displays capture records alongside a stored processing output.
  Both previews use neutral color/base width, without fragment erasing or
  placement. **Try a processor on this trace → Preview policies** compares
  experimental smoothing/pressure/speed/rejection without saving anything. Older
  stored outputs remain selectable after reprocessing.
  **Replay stroke** animates the measured samples at their recorded timing,
  with 0.25×, 1× or 4× speed and Stop. Missing sample clocks fall back to receipt
  clocks; regressions clamp forward and zero-duration captures appear instantly.
  Predictions stay excluded. Replay is display-frame limited and does not write
  to the database. Original and processed geometry replay together using the
  raw sample clock and saved source correspondence. Time zero is the first
  measured raw sample, shared by both views. If processing removes the first
  50 ms, the output first appears at 50 ms; its clock is not silently rebased.
  Replay stops when changing rows, refreshing or leaving the viewer.

Both database viewers include **Database diagnostics**, covering all documents:
ink captures with any visible geometry, all raw captures used by visible ink,
visible/total shapes, event/effect counts, document/page counts and raw JSON/embedded source
payload sizes, rendered/linked content counts and active/total boxes with detector
run/error counts. Visibility means *any fragment remains*, not a fraction of path
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

The private Pages URL above is the easiest tablet test and needs no Mac server.
For a quick drawing-only local check, open `http://<Mac-LAN-IP>:5173` on the same Wi-Fi
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

The importer computes `sha256:<hex>` from original bytes. `asset_refs` stores content
metadata; the optional `blobs(hash, data)` table embeds bytes by default. `assets` is a
compatibility read view. Disable **Embed source files** for an external-content notebook.
References survive; this browser needs the bytes or a replacement backend to render them.
The same PDF can be a source in any number of independent notebooks. Within one notebook,
identical bytes are embedded once, and multiple pages/documents may reference that hash.

**Open PDF** creates/selects a named document; **Insert PDF after current page** instead
inserts its pages into the current document. **Add image / SVG** inserts a page by default;
**Place image / SVG on current page** creates a movable content object. `image/svg+xml`
objects also accept `{source: "<svg …>…</svg>"}` through the content editor. SVG renders
in an image context, without inserting document-supplied markup/scripts into the app DOM.

Each page has independent extent (`page` or `whiteboard`) and an extensible background
source: `source_kind`, optional `source_hash`, optional one-based `source_page`, and opaque
`source_json`. PDF pages use their rotated/cropped PDF.js viewport dimensions; image and
SVG pages use intrinsic image dimensions. Add another source kind through
`Journal.setPageSource` and `PageSources.renderers` (e.g. a future map adapter). Unknown
kinds retain their metadata and display a placeholder. Names remain a mutable human index,
with addresses such as `Paper/2` or `/1`; use stable document/page IDs internally.
`documents.pdf_hash` is only a legacy import convenience, not the page's source of truth.

Backgrounds render beneath the ink, sharing page coordinates and CSS extent. Zoom/DPR
change rendering resolution, not stored coordinates or original source files. **Select PDF
text** in Ink & actions overlays a selectable text layer; switch it off to draw there.
**Annotated PDF · current document** exports mixed pages, ink and rendered objects as a
flattened raster PDF, retaining each page's dimensions. Whiteboards export content bounds.
It excludes linked notes and diagnostic boxes. It is not a vector/editable PDF export;
interactive links/forms and password-protected PDF prompts remain unsupported.

`pdf/library.ts` and `page-sources.ts` depend only on the generic
`ContentSource.read(contentId): Promise<Uint8Array>` boundary in `content.ts`
(`PdfSource` is a type alias). The current implementation is `DatabaseClient.read`, backed
by SQLite in the worker. Replace the injected source to read from another CAS
without changing PDF rendering or navigation. Current SHA-256 IDs are verified
on import/read. Other future CID schemes must be verified by their backend.

**TODO: covalence** should supply arbitrary CIDs, codecs and digest algorithms,
including BLAKE3, through its Rust/TS API. Verified range reads also need a
chunk/tree layout and proofs; a whole-file digest alone does not authenticate
individual byte ranges. No BLAKE3, range fetching or covalence integration is
implemented in this prototype. PDF.js fonts/decoders/worker are bundled locally.

## Identity and schema

See [src/schema.sql](../src/schema.sql). The current schema version is **7**.
Earlier notebooks require export/reset; no backward migration is provided.

| Table/view | Purpose |
| --- | --- |
| `stroke_events` | Immutable raw input gestures: ID, capture session, data version, observations JSON |
| `ink_policies` | Immutable versioned smoothing, pressure/speed and rejection configuration |
| `ink_outputs` | Immutable processed geometry, raw capture/policy references and separate rejection reason |
| `shapes` | Geometry instances: ID, output ID, fractional output-vertex range |
| `styles` | Color, base line width, opacity and blend mode |
| `app_events` | Unified ordered operations: ID, edit time, kind, page, input/tool/style/policy and causal event references |
| `app_event_shapes` | Complete shape visibility, page, style, offset/scale/rotation and paint-order snapshots per edit |
| `latest_shape_states` | Each shape's newest state, ordered by app-event ID |
| `visible_shapes` | Current visible states joined to their geometry, style and raw input |
| `asset_refs`, `blobs`, `assets` | Content metadata, optional embedded bytes, and joined read view |
| `documents`, `pages` | Stable identities and rebuildable topology/name caches |
| `app_event_documents`, `app_event_pages` | Complete journaled name, source, order, extent and deletion effects |
| `current_documents`, `current_pages` | Authoritative latest event projections, including the explicit notebook.create effects |
| `capture_sessions` | Clock origin, browser/source and API exposure metadata |
| `object_contents` | Immutable format/version/JSON payloads, without placement or edit metadata |
| `page_objects`, `object_sources` | Content instances and optional immutable source-shape references |
| `app_event_objects` | Complete content, visibility, rendering, placement, label and order effects |
| `latest_object_states`, `visible_objects` | Current instances on active pages, including linked notes with `rendered=0` |
| `detector_policies`, `detection_runs` | Versioned script/configuration and input snapshot/status/diagnostics |
| `detected_boxes`, `box_shapes` | Immutable oriented regions and constituent shape references |
| `app_event_boxes`, `latest_box_states`, `active_boxes` | Append-only activation effects and current detections |

**Raw capture IDs, output IDs, shape IDs and app-event IDs are separate namespaces.**
One raw gesture can have many processing outputs; one output can have several
shape instances/fragments; many edits can reference a shape. Retaining geometry
while filtering out its historical creation event
does not change its identity. These domain IDs are local to a database. `object_ids` maps mutable instances
to global notebook/timestamp identities; see the [identity rules](README.md#identity).
The exchange assigns all typed records a separate increasing sequence ID.

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
recorded in this same app-event stream; readers use `current_documents`/`current_pages`, and undo/redo appends complete inverse/forward effects.
The default empty-name document and first blank page have explicit `notebook.create` effects.
Topology cache rows never override recorded event effects.

```sql
SELECT * FROM visible_shapes ORDER BY paint_order, id;
```

Latest state uses event ID, not wall-clock time. Paint order is explicit;
shape ID breaks ties deterministically. Pages share one app-event stream,
while placement and page-local editing keep their rendered content separate.

## Filtering history without changing rendering

**Export SQLite → Save notebook · full history** exports the journal. **Visible state + provenance**
builds a new database containing:

1. All document names, byte-identical embedded source assets and page definitions, including
   empty/deleted pages and unbounded boards.
2. Visible shapes and their original IDs/ranges, required outputs/policies,
   raw captures, capture sessions and styles.
3. Active page objects (rendered and linked), their immutable content and source
   shapes; active boxes, detector policies, originating runs and all shapes in
   those runs' input snapshots. Dependencies may include currently hidden ink.
4. One `history.baseline` event with current shape, object and box effects.

The export verifies ordered shape render-input, object and active-box equality. It leaves the source
unchanged, drops prior undo history, and allows subsequent edits/undo/redo in the
new database. When a visible fragment references a raw capture, that whole
capture remains: compaction removes irrelevant edit history, not portions of
sensor data inside a retained dependency. Provenance dependencies can retain
hidden geometry without making it visible. Detection run IDs/input snapshots
survive; their historical triggering event reference becomes NULL in the compact
database because that edit history has been removed.

```sh
pnpm compact event-draw-full.sqlite3 current-state.sqlite3
sqlite3 current-state.sqlite3 'SELECT id, raw_stroke_id, page_id, offset_x, offset_y FROM visible_shapes;'
sqlite3 current-state.sqlite3 'PRAGMA foreign_key_check; PRAGMA integrity_check;'
```

The CLI refuses to overwrite an existing output and accepts only the current
schema. Arbitrarily deleting historical events is unsafe: deleting a hide can
resurrect a shape. Retaining a suffix later will need a baseline at the cutoff
and all referenced resources. Files can be reopened in the app and inspected with ordinary SQLite tools.

**Just what’s drawn** is a stricter baseline export: active page backgrounds, visible ink,
rendered objects, their current styles/placements, raw dependencies, policies and baked outputs.
It drops linked notes, diagnostic boxes/runs, object-source provenance and previous edits.
It also clears legacy document-level PDF hints; page source references remain authoritative.
It retains complete raw contacts when any fragment is visible; it does not trim sensor samples.
Use the provenance-preserving export when those hidden sources or research results matter.
Both modes create a fresh database and leave the source unchanged.

```sh
pnpm compact notebook.sqlite3 drawn.sqlite3 --drawn
pnpm compact notebook.sqlite3 external.sqlite3 --drawn --no-blobs
sqlite3 notebook.sqlite3 < queries/drawn-state.sql
```

The read-only [drawn-state query](../queries/drawn-state.sql) selects current pages, ink,
rendered objects, raw IDs and resource metadata. Simply selecting surviving app events is
insufficient: the exported baseline must capture the newest placement/visibility effect
for every retained object. `drawn_raw_ids` and `drawn_objects` expose those useful subsets.

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
sampling, latency and palm rejection still need device testing. Synchronization and CAS
integration remain future work. Contacts interrupted by blur, backgrounding or viewport
rotation are cancelled using the observations already received; no synthetic sensor
sample is fabricated.

## Processing experiments and reusable plugins

The data flow is `raw capture → versioned policy → immutable ink output → shape
instance + style + placement`. Output JSON contains only `kind: "ink-path"`
and vertices `{x, y, sourceIndex, widthFactor}`. Color, base width, opacity,
tool, edit time and rejection reason stay outside it. `sourceIndex` maps each
vertex to a fractional position in the measured sample stream for replay and
reprocessing fragments. It must increase strictly; processors that reorder or
combine contacts need a different output schema.

`InkProcessors` accepts replaceable smoothing, width and whole-contact
rejection stages. Built-ins include no smoothing, moving average, constant
width, pen pressure, speed width, combined pressure/speed, accept-all and pen-only.
They are deterministic functions
over copied observations. Output validation rejects invalid correspondence,
nonfinite geometry and invalid width factors. An exception or malformed output
persists an empty rejected result with diagnostics, keeping the raw contact.
Whole-contact rejection is not a complete palm rejection system; turning off
Finger drawing routes touches into navigation rather than ink capture.

**Speed width** uses page units/ms, estimated from neighbouring raw sample
intervals. It uses sample clocks, falling back to receipt clocks when missing;
tied/regressing clocks supply no velocity. **Pressure + speed** offers pressure
and speed weights, response exponents, width-factor minimum/maximum, a reference
speed (default 0.5 units/ms), arithmetic/geometric mixing and thicker-fast or
thinner-fast response. With `r = v / (v + referenceSpeed)`, the thicker-fast
factor is `min + (max - min) * r^speedExponent`; thinner-fast uses `(1-r)`.
Pressure uses `min + (max-min) * pressure^pressureExponent`. Configured weights
are normalized by their sum; a missing measurement contributes neutral factor 1,
and two zero weights yield 1. Speed-only fixes the weights at 0 and 1. These
options are also available in the individual-trace preview. Estimates use raw
page-space distance, independently of the smoothing stage and viewport zoom.

Raw clocks remain unchanged in storage. Output vertices carry `sourceIndex`,
so replay derives their time from the original contact rather than storing a
second clock. A processor that trims leading samples therefore retains their
delay in comparisons. A future standalone player can subtract the first retained
time as an explicit presentation option; it should retain that offset and source
mapping. Translating the clock origin does not change speed. Multi-contact fusion
needs explicit shared clock/pen-up semantics, rather than resetting every input
contact to zero and losing their temporal relationship.

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
capture/content models, processing, interactions, detection, geometry, replay and analysis/transformation
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

## Page content and detection plugins

Page text, linked notes and future generated artifacts share `Journal.setObject`
and `deleteObject`. `ObjectInput` carries a format and JSON payload, with placement,
label and rendered/hidden status in separate fields. Markdown and LaTeX use
`{source: string}`. Content deduplicates independently of instances. Optional
`sourceShapeIds` records immutable provenance on creation, retained by compact
export even after that ink is deleted. Deletion/edits are undoable page operations.

`ui/content-renderers.ts` supplies a trusted `contentRenderers` registry used by
both the page and sidebar preview. Markdown/inline math and display LaTeX are
implemented; unknown formats show a safe format/JSON fallback. The format field
accepts MathML and Vega Lite tags for experiments, but **neither has a renderer
yet**. Documents cannot install executable renderers. Objects rotate around
their center in radians (the editor shows degrees) and share page coordinates
with PDF and ink. The DOM content layer currently paints above ink, with clipping
to each object's rectangle; arbitrary shared z-order remains future UI work. Image/SVG content uses the same
format registry as text and future generated artifacts; Move/Resize/Rotate handles
use the same placement events.

`detection.ts` is DOM-free. Inject `BoxDetectors` as the fourth `Journal`
constructor argument, or edit `createBoxDetectors` for notebook experiments:

```ts
const detectors = new BoxDetectors({ id: 'research/rectangle@2', options: {} });
detectors.scripts.set('research/rectangle@2', (input, options) => {
  // input.traces: placed visible points, shape/raw/output IDs and source ranges.
  return []; // BoxCandidate[]: center, dimensions, rotation, confidence, shapeIds
});
```

The built-in `rectangle-outline@1` checks endpoint-connected closed outlines,
fits a minimum-area oriented rectangle, then checks perimeter proximity and all
four edge coverages. It supports rotation and separate nested outlines; it does
not yet persist a parent hierarchy. Default endpoint tolerance is 12 page units,
minimum side 20. Search is bounded to 256 recent intact traces, downsampled to
roughly 257 points each, with at most 16 contacts per connected group. It is a
conservative baseline for experiments, not handwriting/arrow recognition.
Angles are radians, canonicalized approximately to `[-π/4, π/4)`; width/height
may exchange roles across this boundary. Rectangles have no intrinsic reading
direction. Arrowheads/text need an additional directed frame convention.

Ink edits reconcile detections inside the same transaction. `box.finish` records
constituent shape IDs and `box.break` records a change/removal, with a causal
reference to the triggering edit. Partial erasure breaks a box even for a small
cut; fragments are not intact outline inputs. Moving/reprocessing constituents
creates a new derived object. Restyling preserves detection identity. Undo can
reactivate the original box ID when its exact geometry/placement returns, even
outside the detector's current search window. Old objects remain inspectable.
Plugin errors are recorded in `detection_runs`, while ink still saves; changed
constituents still invalidate old boxes. Derived events are not separate undo
steps. The script runs at edit completion, not during an unfinished contact.

For a CLI experiment on an exported notebook:

```sh
pnpm detect event-draw-full.sqlite3
pnpm detect event-draw-full.sqlite3 ./trusted-candidate.mjs
```

The optional module default-exports a `BoxDetector` callback. Node 24 also accepts
strip-compatible `.ts`. The command reads schema 7 without modifying the source
and prints per-page candidate JSON. A custom module's ID hashes that file's bytes;
a future CAS bundle should cover the entire dependency closure. These are trusted
synchronous callbacks, with the same no-preemption limitation as ink processors.

For autoresearch, use a fixed labelled corpus of raw inputs and edit sequences,
including rotations, nested boxes, near misses, erasures and undo. Compare rotated
region overlap/precision/recall, constituent assignment, lifecycle stability and
runtime; reserve held-out examples. Tie candidates, configuration, corpus and
scores to immutable implementation identities. The CLI and per-trace ink preview
are starting points; an automated search/evaluation runner is not implemented.

## Trace, image and server analysis boundaries

`pipelines.ts` describes future async jobs with implementation CID, request ID,
input snapshot key and trace or raster inputs. Hybrid jobs can include both.
Raster inputs carry content ID, dimensions and a pixel-to-page affine transform;
an optional rendering recipe records selected source artifacts, renderer CID and
page bounds. This lets an image detector return regions in reproducible page
coordinates without confusing them with screen pixels. Replies can carry artifacts
and hierarchical oriented regions with source references. `replyIsCurrent` checks
request and snapshot identity; a stale result may be retained for research but
must not replace current detections without validating its dependencies. These
are contracts, not implemented raster rendering jobs, server calls or OCR.

Keep input streaming (contact begin/sample/end/cancel) separate from committed
document operations. For multiplayer, a server can provide authoritative ordering,
or a separate CRDT design can define conflict resolution. The proposed
`OperationEnvelope` has actor, stable ID, sequence and causal parents, but does not
implement either approach. SQLite integers remain local and need reference
mapping; merging files or sorting received events alone does not guarantee
convergence. Detections should reference a source snapshot and exact implementation
so local and server pipelines can use the same validation/provenance rules.

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

The prototype now covers portable notebook files/recovery, mixed page backgrounds,
handwriting, both erasers, undo/redo, ink selection/transforms/duplication, positioned
text/math/images/SVG, linked notes, page picker/continuous reader, text/PDF search and
flattened annotated-PDF export. Browser checks cover Chrome and WebKit; actual tablet
sampling, latency, palm/gesture tuning, memory pressure and suspension still need testing.
A native capture bridge, vector PDF export, inline rich-text editing, searchable handwriting,
sync/collaboration and recognition remain separate work. The continuous reader opens a
page in the editor for changes; it does not edit many pages simultaneously.

Settled ink has a cached layer with grid-based view culling. Built-in local processors
append live samples/path geometry incrementally with exact full-processing equivalence;
nonlocal/experimental processors use the full API. Output parsing and PDF document caches
are bounded; page previews allocate pixel buffers near the viewport and release them when
out of range. Worker state deltas reuse unchanged entities instead of resending all raw
JSON after every operation. The trusted baseline detector is bounded and runs in the DB
worker at contact completion; an untrusted research plugin still needs an isolated worker
with enforceable time/memory budgets.

## Code boundaries

| Module | Responsibility |
| --- | --- |
| `capture.ts`, `model.ts` | Browser snapshots, capture types and measured-sample/local-coordinate policy |
| `ink.ts`, `plugins.ts`, `storage/ink-store.ts` | Versioned processing stages, validated baked outputs and immutable identities |
| `interactions.ts`, `transformations.ts`, `pipelines.ts`, `core.ts` | Lasso/touch policies, future multi-input/analysis/sync contracts and reusable entry point |
| `detection.ts`, `storage/detection-store.ts` | Replaceable rectangle script, validation, derived objects and activation history |
| `geometry.ts` | Pure path/range, erasing, lasso and selection calculations |
| `journal.ts`, `storage/` | Atomic app operations, SQLite queries and schema/reset |
| `database.ts`, `db.worker.ts` | Worker transport, WASM initialization and persistent storage |
| `pages.ts` | Page presets and disposable whiteboard viewports |
| `ui/tool-picker.ts`, `ui/shell.ts` | Tool-button component and page markup |
| `ui/ink-controls.ts` | Registry-driven policy controls and separate pen/highlighter paint preferences |
| `text.ts`, `ui/content-renderers.ts` | Shared Markdown/math rendering and trusted format adapters |
| `storage/object-store.ts`, `ui/text-editor.ts`, `ui/page-objects.ts` | Immutable content, autosaved object drafts and positioned content/region layer |
| `ui/page-navigation.ts`, `ui/notebook-location.ts` | Numbered navigation and disposable location preference |
| `ui/page-surface.ts`, `page-sources.ts` | Fit/pinch/layout and extensible cancellable background rendering |
| `ui/page-browser.ts`, `ui/pdf-text.ts`, `pdf/export.ts` | Lazy grid/continuous reader, search/text selection and flattened export |
| `ui/notebook-files.ts`, `ui/notebook-backups.ts`, `storage/notebooks.ts` | Portable files, recovery snapshots and validated atomic replacement |
| `live-ink.ts`, `spatial.ts`, `state-transport.ts` | Incremental previews, disposable ink index and worker deltas |
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
