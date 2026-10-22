# Stack and portability

The shipped app is a static TypeScript browser app, with vanilla DOM controls and no
React or other UI framework. There is no native wrapper, application server or sync service.

| Layer | Current implementation | Reuse boundary |
| --- | --- | --- |
| Models, processing, geometry, interaction, detection, playback | TypeScript ESM; `event-draw/core` emits JS and declarations | DOM-free; usable in Node, workers or another JS app. Policies/registries take plain data. |
| Journal and projections | SQLite SQL/schema through injected synchronous `SqlDatabase.exec/all` | SQLite-runtime independent; still coupled to this schema and SQL, rather than arbitrary storage. |
| Exchange | Composable sources/sinks, payload bindings, transforms and framing; default typed JSONL | Replaceable separately. Default bindings/reconstruction know this SQLite schema. |
| Raw codecs | `cborg` CBOR and `@bokuweb/zstd-wasm`; Node adapter uses native zstd | Per-row codec IDs; injectable compression interface. No lossy rounding. |
| Browser database host | Official `@sqlite.org/sqlite-wasm` 3.54.1 in a dedicated Web Worker; OPFS SAH pool VFS, Web Lock, memory fallback | Browser-specific adapter. Node CLIs/tests inject `node:sqlite` instead. |
| Input | Pointer Events, coalesced/predicted batches and raw updates when available | Browser-specific capture; another host can populate the shared observation model. Missing optional values remain nullable. |
| Ink rendering | Canvas 2D and cached `Path2D`; variable-radius discs and tangent hulls | Browser-specific renderer. Baked vertices/width factors and shape placement can feed another renderer. |
| Page content | PDF.js 6.4, markdown-it 15, KaTeX 0.19, DOM/SVG/image renderers; pdf-lib and html2canvas-pro for export | Content IDs/backends, payload codecs and placement are reusable; default viewing/editing/export adapters depend on the browser/libraries. |
| Installation | Web manifest, Home Screen icons, Vite-generated static-shell service worker | Browser host only; caches known build assets, never notebook files or arbitrary URLs. |
| Shell and tools | Small TypeScript DOM modules; typed frontend host/commands, extension slots, configurable toolbar/footer | Default controls require DOM; headless commands and data contracts are separate. Trusted modules only. |
| Tooling | Vite 8, TypeScript 7, pnpm 12, Node 24+, Node test runner and Playwright Chromium/WebKit | Static hosting; GitHub Actions checks builds/tests and deploys to public GitHub Pages. |

The core is **host-independent JavaScript**, not a language-independent binary interface.
It currently has no Rust implementation or general WASM plugin loader. A covalence/Rust
port can preserve observation/output/event contracts and provide JS bindings, then replace
individual processors, geometry or content adapters. Browser observation fields remain
browser-shaped even though their TypeScript types are DOM-free. Native capture should
preserve its own evidence through an explicit adapter or new versioned capture format.
Worker RPC and incremental state patches are disposable transport, not notebook authority.

## Writing surface and spatial queries

A notebook can mix growing blank notes, fixed-size pages and whiteboards. New blank notes
start at 1000 × 1600 logical units with `source_json.layout = "note"`; this is an extensible
blank-page hint, not a new SQL schema. `note-pages.ts` contains the DOM-free growth policy.
Edits near the bottom add 800-unit chunks with 320 units of writing room. Positioned content
uses its rotated bounds; linked non-rendered notes do not extend the page. Growth effects
belong to the original edit, so undo/redo, SQLite snapshots and event replay agree. Explicit
**Add writing space** records `page.resize`. Erasing does not automatically shrink a note.
Existing notes retain their recorded dimensions and layout.

`WritingWorkspace` owns optional host preferences (automatic/Notes/Page and finger drawing).
Automatic chooses Notes on coarse-pointer devices. `PageSurface` handles width-fit layout,
scroll/zoom and orientation; `surface-layout.ts` maps the visible CSS rectangle to a logical
page viewport. The visual viewport tracks rotation and the keyboard. `NotebookCanvas` captures that per-delivery transform, keeping observations
correct after scrolling or rotation. Full-page content placement uses a separate view.
Long notes retain a full-size scrolling paper element, but only a viewport-sized ink canvas.
Canvas allocation is bounded by the screen and the existing 16-million-pixel/DPR cap.

`InkIndex` is a disposable **in-memory grid over currently drawn shapes' painted bounds**,
including width, scale, rotation and fractional erasures. `select(view)` returns intersecting
shapes in paint order. Cells have bounded expansion with an overflow list for very long shapes.
The renderer rebuilds the index when the immutable scene changes; scrolling queries it without
serializing every shape, and only intersecting shapes need Canvas paths. Cached settled ink
and weak geometry caches remain independent of notebook authority. This avoids adding a
SQL index or schema migration just for rendering. The worker still materializes notebook state
and transfers scene data: this is paint culling, not out-of-core notebook loading. A future
worker-side temp R-tree and windowed transport can replace this adapter if measurements justify
paging very large notebooks; a single enormous trace can still dominate geometry work.

## Installed browser app and native next

`scripts/offline-shell.ts` generates a versioned cache of the exact production shell, including
worker/WASM/PDF/font assets and icons. It supports relative manifests on Pages subpaths.
`platform/installable-app.ts` owns registration/install/update controls. Development has no
service worker. New builds wait for an explicit update; the app drains text and queued edits
before activating and reloading. Remote URLs are never opportunistically cached. Notebook
and embedded blobs remain in OPFS/SQLite, independently of shell cache cleanup.

Safari's Home Screen web app is the current fullscreen iPad host, with safe-area padding,
dynamic viewport height and no orientation lock. Browser UI/storage policies, keyboard and
pencil behavior still need testing on physical iPads. Export before moving between Safari and
Home Screen storage; local persistence is not a backup. The service worker cannot make remote,
non-embedded content available offline.

Next is a native host (Xcode/signing required) around shared frontend/core contracts. A
WKWebView wrapper can initially share UI, journal and renderers, while native file access or
Pencil capture replace explicit adapters. Native capture must preserve native observations
rather than pretending they are browser Pointer Events. A more native SwiftUI shell can reuse
the schema and processor API later. No native wrapper or general WASM plugin loader ships yet.

## Sustained erasing

Previously each preview frame flattened the entire accumulated contact and clipped every
ink segment against every eraser segment. It also rebuilt the scene index and Canvas paths.
For a fixed page, per-frame clipping grew with contact duration; summed across frames it
grew roughly quadratically. Local pen processing already appended new vertices/path geometry
and reused the settled canvas, explaining why a longer pen contact could feel faster.

The preview now retains an `ErasurePlanner` for the gesture and fixed scene:

1. Read new measured deliveries; exclude predictions and duplicate pointermove summaries.
2. Query painted bounds along each new swept capsule; test only candidate shapes.
3. Clip their retained ranges using the same variable-width capsule geometry. Removed
   whole strokes are skipped on later passes.
4. Reuse the spatial index and unchanged `Path2D` geometry when painting.

Scene/tool/radius changes, replacement/truncated capture or first raw-update arrival
invalidate the preview. The raw contact remains intact. The worker uses the same geometry
planner to compute complete edit effects at release; undo/replay still use those effects.
The preview cache never becomes an input to persistence.

`pnpm bench:eraser` measures growing-prefix batch planning versus append-only planning for
160 shapes × 25 vertices, 1,200 eraser samples and 100 preview updates. It checks final range
equivalence and reports total geometry time plus a one-shot commit. An optional positional
argument loads a historical module exporting `planErasure` (resolve its imports to this
checkout first). The default baseline uses today's faster clip primitive with the old
whole-prefix strategy; the table below uses the historical implementation instead.
This measures geometry, excluding Canvas painting, capture, compression,
SQL and detections; it is not an iPad frame-rate benchmark. On the development Mac, using
the original planner at `38623dc` as baseline (one run, rounded):

| Tool | Old accumulated previews | New accumulated previews | New one-shot commit |
| --- | ---: | ---: | ---: |
| Partial eraser | 55.9 s | 9.0 ms | 6.9 ms |
| Whole-stroke eraser | 56.5 s | 3.8 ms | 2.8 ms |

These large ratios describe this synthetic workload, not end-to-end frame-rate gains.
Unit tests compare every
incremental prefix with batch clipping across variable widths, rotations, fractional
fragments, dots and stream changes. Browser tests compare held-contact previews with
committed pixels and verify cancellation/undo in both engines.

Remaining costs depend on visible ink and new work: painting still fills visible paths,
and a very long individual shape or heavily fragmented output can require many segment/range
checks. Segment-level indexing, dirty-region painting and worker geometry are possible
next steps if real-device profiles justify them. Commit also compresses the capture, writes
effects and runs detection; a release-time pause is a separate measurement.

## Read-only SQL analysis window

The existing Events tab browses tables/views through fixed read-only queries. It does not
accept arbitrary SQL. A query window is a modest additional feature using the existing
notebook export: give a separate analysis worker a point-in-time snapshot, open a separate
connection, enforce read-only SQL with SQLite controls/authorizer (including PRAGMA/ATTACH
restrictions), and bound result rows/bytes. Terminating the analysis worker supplies a
reliable cancellation boundary for expensive queries. Explicit Refresh replaces the snapshot.
This keeps analysis independent of the drawing worker and live writer. SQL text filtering
alone is not an adequate read-only boundary. This window is not implemented yet.

For now export a notebook and inspect it locally:

```sh
sqlite3 -readonly notebook.sqlite3
```
