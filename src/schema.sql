PRAGMA foreign_keys = ON;
PRAGMA user_version = 5;

-- Content IDs are opaque to readers. The current importer emits sha256:<hex>.
CREATE TABLE IF NOT EXISTS assets (
  hash TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length > 0),
  data BLOB NOT NULL CHECK (length(data) = byte_length)
) STRICT;

-- Human names are an index over document identity, separate from page identity.
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE CHECK (instr(name, '/') = 0),
  pdf_hash TEXT UNIQUE REFERENCES assets(hash)
) STRICT;
INSERT OR IGNORE INTO documents VALUES (1, '', NULL);

CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id),
  page_number INTEGER NOT NULL CHECK (page_number > 0),
  source_page INTEGER CHECK (source_page > 0),
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  kind TEXT NOT NULL CHECK (kind IN ('page', 'whiteboard')),
  width REAL,
  height REAL,
  CHECK ((kind = 'page' AND width IS NOT NULL AND height IS NOT NULL AND width > 0 AND height > 0)
      OR (kind = 'whiteboard' AND width IS NULL AND height IS NULL AND source_page IS NULL))
) STRICT;
CREATE INDEX IF NOT EXISTS document_page_order ON pages(document_id, deleted, page_number);
INSERT OR IGNORE INTO pages VALUES (1, 1, 1, NULL, 0, 'page', 1000.0, 1200.0);

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
  data_json TEXT NOT NULL CHECK (json_valid(data_json))
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
  tool TEXT,
  style_id INTEGER REFERENCES styles(id),
  policy_id INTEGER REFERENCES ink_policies(id),
  cause_event_id INTEGER REFERENCES app_events(id),
  eraser_radius REAL CHECK (eraser_radius > 0),
  undoable INTEGER NOT NULL DEFAULT 0 CHECK (undoable IN (0, 1)),
  undo_of_event_id INTEGER REFERENCES app_events(id),
  data_version INTEGER NOT NULL DEFAULT 1 CHECK (data_version > 0),
  data_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data_json))
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS one_undo_per_event
  ON app_events(undo_of_event_id) WHERE undo_of_event_id IS NOT NULL;

-- Complete placement/style/visibility snapshots make replay and undo simple.
CREATE TABLE IF NOT EXISTS app_event_shapes (
  app_event_id INTEGER NOT NULL REFERENCES app_events(id),
  shape_id INTEGER NOT NULL REFERENCES shapes(id),
  visible INTEGER NOT NULL CHECK (visible IN (0, 1)),
  page_id INTEGER NOT NULL REFERENCES pages(id),
  style_id INTEGER NOT NULL REFERENCES styles(id),
  offset_x REAL NOT NULL,
  offset_y REAL NOT NULL,
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
       e.page_id, e.style_id, e.offset_x, e.offset_y, e.paint_order,
       t.color, t.line_width, t.opacity, t.blend_mode, r.data_version, r.data_json,
       o.data_version AS output_version, o.data_json AS output_json
FROM latest_shape_states e
JOIN shapes s ON s.id = e.shape_id
JOIN ink_outputs o ON o.id = s.output_id
JOIN stroke_events r ON r.id = o.raw_stroke_id
JOIN styles t ON t.id = e.style_id
JOIN pages p ON p.id = e.page_id
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
JOIN object_contents c ON c.id = e.content_id JOIN pages p ON p.id = e.page_id
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
JOIN pages p ON p.id = b.page_id WHERE e.active = 1 AND p.deleted = 0;
