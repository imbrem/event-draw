PRAGMA foreign_keys = ON;
-- A 256-bit schema-family UUID and a SemVer, independent of notebook identity.
-- PRAGMA user_version is intentionally unused.
CREATE TABLE IF NOT EXISTS schema_identity (
  id INTEGER PRIMARY KEY CHECK(id=1),
  uuid TEXT NOT NULL CHECK(length(uuid)=64 AND uuid NOT GLOB '*[^0-9a-f]*'),
  version TEXT NOT NULL
) STRICT;
INSERT OR IGNORE INTO schema_identity VALUES(1,'7f0cfa452687929ea325a82a41333105813ba9c52d382f7e29d325216afe79ff','0.0.0');

-- Namespaces include self and foreign notebooks; integers are local aliases only.
CREATE TABLE IF NOT EXISTS notebook_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE CHECK(length(uuid)=64 AND uuid NOT GLOB '*[^0-9a-f]*')
) STRICT;
CREATE TABLE IF NOT EXISTS notebook_metadata (
  id INTEGER PRIMARY KEY CHECK(id=1),
  self_import_id INTEGER NOT NULL UNIQUE REFERENCES notebook_imports(id),
  created_at TEXT NOT NULL,
  last_timestamp_us INTEGER NOT NULL CHECK(last_timestamp_us>=0 AND last_timestamp_us<=9007199254740991)
) STRICT;
-- Bind a reusable identity to an optional application-local entity.
CREATE TABLE IF NOT EXISTS object_ids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id INTEGER NOT NULL REFERENCES notebook_imports(id),
  timestamp_us INTEGER NOT NULL CHECK(timestamp_us>0 AND timestamp_us<=9007199254740991),
  kind TEXT NOT NULL,
  local_id INTEGER,
  UNIQUE(import_id,timestamp_us), UNIQUE(kind,local_id)
) STRICT;

-- Content IDs are opaque to readers. The current importer emits sha256:<hex>.
CREATE TABLE IF NOT EXISTS asset_refs (
  hash TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length > 0)
) STRICT;

-- Blobs are optional portable payloads; references survive externalization.
CREATE TABLE IF NOT EXISTS blobs (hash TEXT PRIMARY KEY REFERENCES asset_refs(hash), data BLOB NOT NULL) STRICT;
CREATE VIEW IF NOT EXISTS assets AS SELECT a.*, b.data FROM asset_refs a LEFT JOIN blobs b USING(hash);

-- Human names are an index over document identity, separate from page identity.
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE CHECK (instr(name, '/') = 0),
  pdf_hash TEXT REFERENCES asset_refs(hash)
) STRICT;
INSERT OR IGNORE INTO documents VALUES (1, '', NULL);

CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id),
  page_number INTEGER NOT NULL CHECK (page_number > 0),
  source_page INTEGER CHECK (source_page > 0),
  source_kind TEXT NOT NULL DEFAULT 'blank',
  source_hash TEXT REFERENCES asset_refs(hash),
  source_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(source_json)),
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  kind TEXT NOT NULL CHECK (kind IN ('page', 'whiteboard')),
  width REAL,
  height REAL,
  CHECK ((kind = 'page' AND width IS NOT NULL AND height IS NOT NULL AND width > 0 AND height > 0)
      OR (kind = 'whiteboard' AND width IS NULL AND height IS NULL AND source_page IS NULL))
) STRICT;
CREATE INDEX IF NOT EXISTS document_page_order ON pages(document_id, deleted, page_number);
INSERT OR IGNORE INTO pages (id,document_id,page_number,kind,width,height) VALUES(1,1,1,'page',1000.0,1200.0);

CREATE TABLE IF NOT EXISTS capture_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  source TEXT NOT NULL,
  time_origin_ms REAL NOT NULL,
  user_agent TEXT NOT NULL,
  device_pixel_ratio REAL NOT NULL,
  capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json))
) STRICT;

-- Raw sensor captures ONLY. No page, tool, style, edit time or placement here.
CREATE TABLE IF NOT EXISTS stroke_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  capture_session_id INTEGER REFERENCES capture_sessions(id),
  data_version INTEGER NOT NULL CHECK (data_version > 0),
  data_codec TEXT NOT NULL,
  decoded_bytes INTEGER NOT NULL CHECK(decoded_bytes>=0 AND decoded_bytes<=67108864),
  data BLOB NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS styles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  color TEXT NOT NULL,
  line_width REAL NOT NULL CHECK (line_width > 0),
  opacity REAL NOT NULL CHECK (opacity > 0 AND opacity <= 1),
  blend_mode TEXT NOT NULL CHECK (blend_mode IN ('source-over', 'multiply')),
  UNIQUE (color, line_width, opacity, blend_mode)
) STRICT;

CREATE TABLE IF NOT EXISTS ink_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  config_json TEXT NOT NULL UNIQUE CHECK (json_valid(config_json))
) STRICT;
CREATE TABLE IF NOT EXISTS ink_outputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_stroke_id INTEGER NOT NULL REFERENCES stroke_events(id),
  policy_id INTEGER NOT NULL REFERENCES ink_policies(id),
  rejection_reason TEXT,
  data_version INTEGER NOT NULL CHECK (data_version > 0),
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  UNIQUE (raw_stroke_id, policy_id)
) STRICT;

-- Derived shapes reference ranges of processed output vertices. Erasing never inserts
-- synthetic samples into stroke_events. Fractional indices interpolate.
CREATE TABLE IF NOT EXISTS shapes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  output_id INTEGER NOT NULL REFERENCES ink_outputs(id),
  start_index REAL NOT NULL CHECK (start_index >= 0),
  end_index REAL NOT NULL CHECK (end_index >= start_index)
) STRICT;

CREATE TABLE IF NOT EXISTS app_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  document_id INTEGER REFERENCES documents(id),
  page_id INTEGER REFERENCES pages(id),
  raw_stroke_id INTEGER REFERENCES stroke_events(id),
  session_id INTEGER REFERENCES capture_sessions(id),
  tool TEXT,
  style_id INTEGER REFERENCES styles(id),
  policy_id INTEGER REFERENCES ink_policies(id),
  cause_event_id INTEGER REFERENCES app_events(id),
  eraser_radius REAL CHECK (eraser_radius > 0),
  undoable INTEGER NOT NULL DEFAULT 0 CHECK (undoable IN (0, 1)),
  undo_of_event_id INTEGER REFERENCES app_events(id),
  redo_of_event_id INTEGER REFERENCES app_events(id),
  data_version INTEGER NOT NULL DEFAULT 1 CHECK (data_version > 0),
  data_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data_json))
) STRICT;
CREATE INDEX IF NOT EXISTS undo_history ON app_events(undo_of_event_id);
-- Complete event effects are authoritative; topology tables are rebuildable caches.
CREATE TABLE IF NOT EXISTS app_event_documents (
  app_event_id INTEGER NOT NULL REFERENCES app_events(id), document_id INTEGER NOT NULL REFERENCES documents(id),
  name TEXT NOT NULL, pdf_hash TEXT REFERENCES asset_refs(hash), PRIMARY KEY(app_event_id,document_id)
) STRICT;
CREATE TABLE IF NOT EXISTS app_event_pages (
  app_event_id INTEGER NOT NULL REFERENCES app_events(id), page_id INTEGER NOT NULL REFERENCES pages(id),
  document_id INTEGER NOT NULL REFERENCES documents(id), page_number INTEGER NOT NULL,
  source_page INTEGER, source_kind TEXT NOT NULL, source_hash TEXT REFERENCES asset_refs(hash), source_json TEXT NOT NULL CHECK(json_valid(source_json)),
  deleted INTEGER NOT NULL CHECK(deleted IN(0,1)), kind TEXT NOT NULL, width REAL, height REAL,
  PRIMARY KEY(app_event_id,page_id)
) STRICT;
CREATE INDEX IF NOT EXISTS page_effect_history ON app_event_pages(page_id,app_event_id DESC);
CREATE VIEW IF NOT EXISTS current_pages AS
SELECT e.page_id AS id,e.document_id,e.page_number,e.source_page,e.source_kind,e.source_hash,e.source_json,e.deleted,e.kind,e.width,e.height
FROM app_event_pages e WHERE NOT EXISTS(SELECT 1 FROM app_event_pages n WHERE n.page_id=e.page_id AND n.app_event_id>e.app_event_id);
CREATE VIEW IF NOT EXISTS current_documents AS
SELECT e.document_id AS id,e.name,e.pdf_hash FROM app_event_documents e
WHERE NOT EXISTS(SELECT 1 FROM app_event_documents n WHERE n.document_id=e.document_id AND n.app_event_id>e.app_event_id);

-- Complete placement/style/visibility snapshots make replay and undo simple.
CREATE TABLE IF NOT EXISTS app_event_shapes (
  app_event_id INTEGER NOT NULL REFERENCES app_events(id),
  shape_id INTEGER NOT NULL REFERENCES shapes(id),
  visible INTEGER NOT NULL CHECK (visible IN (0, 1)),
  page_id INTEGER NOT NULL REFERENCES pages(id),
  style_id INTEGER NOT NULL REFERENCES styles(id),
  offset_x REAL NOT NULL,
  offset_y REAL NOT NULL,
  scale REAL NOT NULL DEFAULT 1 CHECK(scale>0),
  rotation REAL NOT NULL DEFAULT 0,
  paint_order INTEGER NOT NULL,
  PRIMARY KEY (app_event_id, shape_id)
) STRICT;
CREATE INDEX IF NOT EXISTS shape_effect_history
  ON app_event_shapes(shape_id, app_event_id DESC);

CREATE VIEW IF NOT EXISTS latest_shape_states AS
SELECT e.* FROM app_event_shapes e
WHERE NOT EXISTS (
  SELECT 1 FROM app_event_shapes later
  WHERE later.shape_id = e.shape_id AND later.app_event_id > e.app_event_id
);

CREATE VIEW IF NOT EXISTS visible_shapes AS
SELECT s.id, o.raw_stroke_id, s.output_id, s.start_index, s.end_index,
       e.page_id, e.style_id, e.offset_x, e.offset_y, e.scale, e.rotation, e.paint_order,
       t.color, t.line_width, t.opacity, t.blend_mode, r.data_version, r.data_codec, r.decoded_bytes, r.data,
       o.data_version AS output_version, o.data_json AS output_json
FROM latest_shape_states e
JOIN shapes s ON s.id = e.shape_id
JOIN ink_outputs o ON o.id = s.output_id
JOIN stroke_events r ON r.id = o.raw_stroke_id
JOIN styles t ON t.id = e.style_id
JOIN current_pages p ON p.id = e.page_id
WHERE e.visible = 1 AND p.deleted = 0;

-- Content is independent of its page placement or whether it is rendered.
CREATE TABLE IF NOT EXISTS object_contents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  format TEXT NOT NULL CHECK (length(format) > 0),
  data_version INTEGER NOT NULL CHECK (data_version > 0),
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  UNIQUE (format, data_version, data_json)
) STRICT;
CREATE TABLE IF NOT EXISTS page_objects (id INTEGER PRIMARY KEY AUTOINCREMENT) STRICT;
CREATE TABLE IF NOT EXISTS object_sources (
  object_id INTEGER NOT NULL REFERENCES page_objects(id),
  shape_id INTEGER NOT NULL REFERENCES shapes(id),
  PRIMARY KEY (object_id, shape_id)
) STRICT;
CREATE TABLE IF NOT EXISTS app_event_objects (
  app_event_id INTEGER NOT NULL REFERENCES app_events(id),
  object_id INTEGER NOT NULL REFERENCES page_objects(id),
  page_id INTEGER NOT NULL REFERENCES pages(id),
  content_id INTEGER NOT NULL REFERENCES object_contents(id),
  visible INTEGER NOT NULL CHECK (visible IN (0, 1)),
  rendered INTEGER NOT NULL CHECK (rendered IN (0, 1)),
  x REAL NOT NULL, y REAL NOT NULL,
  width REAL NOT NULL CHECK (width > 0), height REAL NOT NULL CHECK (height > 0),
  rotation REAL NOT NULL,
  label TEXT NOT NULL,
  paint_order INTEGER NOT NULL,
  PRIMARY KEY (app_event_id, object_id)
) STRICT;
CREATE INDEX IF NOT EXISTS object_history ON app_event_objects(object_id, app_event_id DESC);
CREATE VIEW IF NOT EXISTS latest_object_states AS
SELECT e.* FROM app_event_objects e WHERE NOT EXISTS
  (SELECT 1 FROM app_event_objects later WHERE later.object_id = e.object_id AND later.app_event_id > e.app_event_id);
CREATE VIEW IF NOT EXISTS visible_objects AS
SELECT o.id, e.page_id, e.content_id, c.format, c.data_version, c.data_json,
       e.rendered, e.x, e.y, e.width, e.height, e.rotation, e.label, e.paint_order
FROM latest_object_states e JOIN page_objects o ON o.id = e.object_id
JOIN object_contents c ON c.id = e.content_id JOIN current_pages p ON p.id = e.page_id
WHERE e.visible = 1 AND p.deleted = 0;

CREATE TABLE IF NOT EXISTS detector_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  config_json TEXT NOT NULL UNIQUE CHECK (json_valid(config_json))
) STRICT;
CREATE TABLE IF NOT EXISTS detection_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL REFERENCES pages(id),
  policy_id INTEGER NOT NULL REFERENCES detector_policies(id),
  input_event_id INTEGER REFERENCES app_events(id),
  input_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'error')),
  diagnostics_json TEXT NOT NULL CHECK (json_valid(diagnostics_json))
) STRICT;
-- Immutable oriented regions and relational source provenance.
CREATE TABLE IF NOT EXISTS detected_boxes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL REFERENCES pages(id),
  policy_id INTEGER NOT NULL REFERENCES detector_policies(id),
  run_id INTEGER NOT NULL REFERENCES detection_runs(id),
  source_key TEXT NOT NULL,
  center_x REAL NOT NULL, center_y REAL NOT NULL,
  width REAL NOT NULL CHECK (width > 0), height REAL NOT NULL CHECK (height > 0),
  rotation REAL NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  UNIQUE (page_id, policy_id, source_key)
) STRICT;
CREATE TABLE IF NOT EXISTS box_shapes (
  box_id INTEGER NOT NULL REFERENCES detected_boxes(id),
  shape_id INTEGER NOT NULL REFERENCES shapes(id),
  PRIMARY KEY (box_id, shape_id)
) STRICT;
CREATE TABLE IF NOT EXISTS app_event_boxes (
  app_event_id INTEGER NOT NULL REFERENCES app_events(id),
  box_id INTEGER NOT NULL REFERENCES detected_boxes(id),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  PRIMARY KEY (app_event_id, box_id)
) STRICT;
CREATE INDEX IF NOT EXISTS box_history ON app_event_boxes(box_id, app_event_id DESC);
CREATE VIEW IF NOT EXISTS latest_box_states AS
SELECT e.* FROM app_event_boxes e WHERE NOT EXISTS
  (SELECT 1 FROM app_event_boxes later WHERE later.box_id = e.box_id AND later.app_event_id > e.app_event_id);
CREATE VIEW IF NOT EXISTS active_boxes AS
SELECT b.*, (SELECT json_group_array(shape_id) FROM
  (SELECT shape_id FROM box_shapes WHERE box_id = b.id ORDER BY shape_id)) AS shape_ids
FROM latest_box_states e JOIN detected_boxes b ON b.id = e.box_id
JOIN current_pages p ON p.id = b.page_id WHERE e.active = 1 AND p.deleted = 0;

CREATE VIEW IF NOT EXISTS drawn_objects AS SELECT * FROM visible_objects WHERE rendered=1;
CREATE VIEW IF NOT EXISTS drawn_raw_ids AS SELECT DISTINCT raw_stroke_id AS id FROM visible_shapes;
