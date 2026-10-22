# Trace storage and compression

[Architecture](README.md) · [Schema](../src/schema.sql) · [Codec API](../src/trace-codecs.ts)

## Notebook schema identity

The schema family has a fixed random 256-bit UUID (64 lowercase hex digits) plus SemVer:

```json
{"uuid":"7f0cfa452687929ea325a82a41333105813ba9c52d382f7e29d325216afe79ff","version":"0.0.0"}
```

This is distinct from each notebook's random namespace. The same value appears in:

- `schema_identity`, a singleton SQLite metadata table.
- `notebook.create.data_json.schema` and reduced `history.baseline` events.
- The `schema` field in the JSONL notebook header, even if creation history was filtered out.

During early development, incompatible schema experiments rotate the UUID and keep `0.0.0`.
A released family can keep its UUID and advance SemVer, with first-class importers for older
versions. Different UUIDs identify separate families/apps; optional conversion plugins may
bridge them. The current reader accepts an **exact UUID + version** match. SQLite's integer
`user_version` is unused. Unknown/missing identities leave local data untouched and expose
export/reset. No importer is implemented yet.

Later, an upgrade may append an event preserving its earlier history, or transform an event
stream during filtering/reconstruction. Identity checks, payload codecs and stream transforms
are separate boundaries; neither upgrade strategy is baked into the current reader.

## Raw traces

`stroke_events` stores one entire contact, including measured/coalesced/predicted deliveries.
The raw value still contains only sensor observations, clocks and coordinate transforms.
Style, app tool, placement, page and edit time stay in referencing records.

```sql
SELECT id, capture_session_id, data_version, data_codec,
       decoded_bytes, length(data) AS stored_bytes
FROM stroke_events;
```

- `data_version = 1` describes the observation structure.
- `data_codec = 'cbor+zstd@1'` describes its encoding: ordinary CBOR, then one zstd frame per contact.
- `data` is a BLOB. `decoded_bytes` is the CBOR size before compression, not JSON size.
- No rounding, quantization, field dropping, or duplicate JSON payload is stored.
- `json@1` and `cbor@1` are alternative host-selectable encodings; rows may mix codecs.
- Unknown codecs/versions, corrupt frames and mismatched sizes fail explicitly. The current per-trace
  decoded/encoded size limit is 64 MiB. Frame size is checked before WASM decompression.

`TracePayloads.codecs` accepts trusted encode/decode adapters; `writeCodec` selects new writes.
Existing rows retain their own codec. `cborZstdCodec` composes CBOR with an injected compressor.
The browser worker initializes zstd WASM once, and Node CLIs install the native zstd adapter
from `node-trace-codecs.ts`. Neither implementation must emit identical compressed bytes;
they must decode the same wire format. These are not yet canonical content-addressed values.
A future DRISL/DASL profile needs its own explicit constraints and conformance tests; this
implementation does not claim that profile.

The raw viewer shows `data` as a BLOB byte count and adds **computed `decoded_json`** for
inspection/replay. Rendering/reprocessing currently expands raw data in memory, cached for
the visible scene; compression reduces storage, not all runtime memory or worker traffic.
SQLite exports and compact snapshots copy encoded payloads unchanged. Default JSONL exchange
preserves them as base64 `$bytes` records; payload bindings/transforms remain replaceable.

## Processed traces

Find them in **Menu → Events → Database table → `ink_outputs`**, or expand
**Processed trace data** beneath a raw trace's replay. The immutable output format is defined
by [`InkOutput` and `InkPoint`](../src/ink.ts). `data_version=1` currently stores JSON:

```json
{"kind":"ink-path","points":[
  {"x":0,"y":0,"sourceIndex":0,"widthFactor":0.8},
  {"x":15.25,"y":4.5,"sourceIndex":1.5,"widthFactor":1.2}
]}
```

- Positions use raw-trace local coordinates. Fractional `sourceIndex` maps to the raw sample clock.
- `widthFactor` multiplies the referencing paint's base width; color and placement stay separate.
- Raw ID, policy ID, rejection reason and output version are separate columns.
- An erased fragment references a range of this output. A new processor creates another immutable output.

Processed geometry compresses too. It remains JSON in this pass because SQLite validation
queries currently inspect its point array. Its geometry format, encoding and processor policy
are independent concepts; the codec abstraction can be reused when those queries are adapted.

## Reproduce the benchmark

```sh
pnpm bench:strokes                    # deterministic synthetic corpus
pnpm bench:strokes notebook.sqlite3   # read-only; raw and stored processed outputs
```

The default corpus is **64 synthetic pen contacts**, 120 measured samples each, with reported,
coalesced and predicted observations, full-precision floating-point coordinates and optional
sensor fields. It is not an iPad hardware recording. Every CBOR and zstd round-trip is checked.
Node zstd level 3, `cborg` 6.1.4; payload bytes only, excluding SQLite/index/codec metadata:

| Per-object encoding | Raw total | Processed total |
| --- | ---: | ---: |
| JSON | 9,023,821 B | 748,518 B |
| CBOR | 5,841,244 B | 445,440 B |
| JSON + zstd | 935,336 B | 251,594 B |
| CBOR + zstd | 738,576 B | 188,551 B |

CBOR + zstd saves **91.8%** of raw JSON and **74.8%** of processed JSON in this corpus.
Batching the entire corpus yields 735,904 B raw / 165,603 B processed for CBOR + zstd, but
per-contact frames preserve independent reads, filtering and replay. Production WASM sizes
may differ. Binary floats avoid decimal spelling overhead without discarding numeric precision;
repeated keys/fields also account for much of JSON's strong compression. Real device data,
stroke length, field availability and prediction behavior will change these ratios.
