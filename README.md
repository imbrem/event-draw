# Event Draw

A deliberately small browser notebook: one page, raw pen capture, an append-only
SQLite edit journal, undo/clear, and full-history or visible-state SQLite export.
No account, server, native wrapper, or covalence dependency yet.

## Run

Node 24+ and pnpm:

```sh
pnpm install
pnpm dev
```

Open http://localhost:5173 on this Mac. Draw with a mouse, pen, or finger.
Turn off **Finger drawing** when using a pen to avoid drawing with your palm.
This is a simple input filter, not a full palm-rejection implementation.

An iPad/Android tablet can reach the printed LAN address, but browser filesystem
APIs require a secure context. Use a **trusted HTTPS origin** for persistent
tablet testing. Plain LAN HTTP uses an explicitly labelled session-only database
where supported; export before closing it. HTTPS hosting/tunnelling is not
configured by this prototype.

The local database belongs to this browser profile and origin (including port).
One tab owns it at a time. Another tab falls back to session-only storage with a
notice. Browser data can be cleared or evicted; export files you want to keep.

```sh
pnpm build           # type check + static production bundle in dist/
pnpm preview         # serve the built app on localhost:4173
pnpm test            # Node's real SQLite + capture tests
pnpm exec playwright install webkit  # once, for Safari-engine tests
pnpm test:browser    # Chrome + WebKit; start pnpm dev first
```

Browser tests use separate test profiles, installed Google Chrome, and Playwright WebKit.
WebKit uses a temporary on-disk profile because its ephemeral test contexts
do not support OPFS.
Node's built-in SQLite is used for CLI tooling/tests; SQLite WASM runs in a
worker in the browser, with OPFS SAH-pool persistence. No special HTTP headers
are needed for this VFS. Build/runtime assets are served locally.

## Shape identity and edit identity

The schema is in [src/schema.sql](src/schema.sql).

| Table/view | Purpose |
| --- | --- |
| `stroke_events` | Immutable shape records: integer ID, geometry/capture JSON |
| `app_events` | Ordered semantic edits: integer ID, kind, edit time, version, payload |
| `app_event_strokes` | Foreign-key references with show/hide effects and paint order |
| `visible_strokes` | View selecting each shape whose latest effect is show |
| `pages` | Page dimensions, currently one 1000 × 1200 page |
| `capture_sessions` | Capture clock origin, browser/source, API availability |

**Shape IDs and app-event IDs are separate namespaces.** The same integer can
occur in both; they identify different things. Names consistently distinguish
`stroke_event_id` and `app_event_id`. These IDs are local to a database,
not globally unique synchronization IDs.

Despite the requested table name, a row in `stroke_events` is a shape resource,
not an edit operation or a single pointer callback. A captured stroke is one row
with all its deliveries in JSON. `kind` and `data_version` allow future
self-contained geometry such as paths or polygons.

One app event can show/hide many shapes. A future partial erase can atomically
hide the original and show two new fragments, without changing the original.
The small junction table gives those references foreign-key integrity; putting
IDs only inside event JSON would make SQL queries and filtering harder.
An event can also have no shape references, allowing later text/document events.

Making shapes a subset of a universal event table is possible, but ties geometry
identity to the historical creation event. Separate IDs let us retain a shape
while removing its creation/edit history. They also naturally model multiple
edits referring to one shape, and one edit referring to multiple shapes.

## Column discipline

Edit time is `app_events.occurred_at`; shape creation time is
`stroke_events.created_at`. Kind/version, page/session references, status,
color and pen width are columns. Undo references are foreign-key columns.
Environment metadata lives in capture sessions, not in geometry JSON.

The shape's JSON contains stroke observations only: deliveries, their original
reported/coalesced/predicted samples, receipt/sample clocks, and client-to-page
transforms. Sample times are part of the captured trajectory, distinct from
wall-clock edit metadata. Delivery receipt times use `performance.now()`;
sample times retain `PointerEvent.timeStamp`, both relative to the recorded
session time origin.

Geometry uses fixed page units. Original browser coordinates/contact dimensions
retain CSS-pixel units. Tilt/twist are degrees; altitude/azimuth are radians.
Pressure is the browser's reported normalized value. Rendering uses constant
width for now; pressure is recorded without assuming it is measured.

All writes of a shape and its app event/effects are one transaction. Undo and
clear append effects, leaving previous rows intact. Current state is read with:

```sql
SELECT * FROM visible_strokes ORDER BY paint_order, id;
```

Paint order is explicit, independent of shape IDs and edit timestamps. Equal
paint orders use shape ID as a deterministic tie-breaker.

## Filtering history without changing the drawing

**Export SQLite → Full history** exports the current journal.
**Visible state only** builds a new database containing:

1. The visible shapes, with original shape IDs and JSON unchanged.
2. Their referenced capture sessions and page definitions.
3. One `history.baseline` event showing them in the same paint order.

The export compares the ordered render inputs before returning the file.
It does not modify the source database. It removes hidden/cancelled shapes and
previous edits, and therefore intentionally loses old undo history. It preserves
current rendering and allows new edits/undo after the baseline.

The same operation is available from the CLI:

```sh
pnpm compact event-draw-full.sqlite3 current-state.sqlite3
sqlite3 current-state.sqlite3 'SELECT id, kind, color, width, paint_order FROM visible_strokes ORDER BY paint_order, id;'
sqlite3 current-state.sqlite3 'PRAGMA foreign_key_check; PRAGMA integrity_check;'
```

The CLI refuses to overwrite an existing output. Snapshot geometry must be
self-contained; a future derived shape should materialize its geometry instead
of requiring deleted ancestors to render.

Arbitrarily deleting app-event rows is not safe: deleting a hide can resurrect
a shape. To retain a suffix of history later, checkpoint at the cutoff, write a
baseline for that state, and retain subsequent events and referenced data.
The current prototype implements the simpler complete-history compaction.
Future text/layer/asset state must be included in the baseline and equality
check when those features arrive.

## Capture behavior and limits

- Snapshot values immediately inside each callback.
- Preserve the delivered event plus separate coalesced and predicted lists.
- Capture `pointerrawupdate` when emitted, and keep `pointermove` too.
  Render raw-update observations when present to avoid drawing both overlapping
  streams. Otherwise render coalesced observations, falling back to the delivered
  sample. Predictions are retained but are not drawn as measured ink.
- Preserve reported pressure, angles, contact dimensions, IDs, buttons, original
  coordinates, transforms and timestamps. Missing numeric fields are `null`;
  reported zero/default values are retained. Field exposure is not hardware
  support: pressure can default to 0.5, for example.
- Capture cancelled strokes and their app-event references, but leave them hidden.
- Unsupported shape kinds/versions remain stored but are skipped by this renderer.

Completed/cancelled strokes commit at the end of contact. The active stroke is
in memory until then; a crash or forced close mid-stroke can lose it. A failed
write stops new drawing and offers JSON export of unsaved captures. Full SQLite
export still covers successfully saved records.

Browser events are browser-delivered observations, not unprocessed digitizer
samples. Native capture may expose additional measurements and corrections.
Real iPad/pencil sampling, latency and palm rejection still need device testing.
PDFs, text, partial erasing, redo, importing files, synchronization, and CAS
integration are intentionally future work.

The TS model, SQLite journal and browser adapters are separate modules. Generic
CID/blob/codec/CAS bindings can later move into covalence behind a TS API. Its
float-free DASL manifests can link to versioned raw byte blobs for these
float-valued observations.
