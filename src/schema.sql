PRAGMA foreign_keys = ON;
PRAGMA user_version = 2;

CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('page', 'whiteboard')),
  width REAL,
  height REAL,
  CHECK ((kind = 'page' AND width IS NOT NULL AND height IS NOT NULL AND width > 0 AND height > 0)
      OR (kind = 'whiteboard' AND width IS NULL AND height IS NULL))
) STRICT;
INSERT OR IGNORE INTO pages VALUES (1, 'Untitled', 'page', 1000.0, 1200.0);

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
  UNIQUE (color, line_width)
) STRICT;

-- Derived shapes reference ranges of raw captures. Erasing never inserts
-- synthetic samples into stroke_events. Fractional indices interpolate.
CREATE TABLE IF NOT EXISTS shapes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_stroke_id INTEGER NOT NULL REFERENCES stroke_events(id),
  start_index REAL NOT NULL CHECK (start_index >= 0),
  end_index REAL NOT NULL CHECK (end_index >= start_index)
) STRICT;

CREATE TABLE IF NOT EXISTS app_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  page_id INTEGER REFERENCES pages(id),
  raw_stroke_id INTEGER REFERENCES stroke_events(id),
  tool TEXT,
  style_id INTEGER REFERENCES styles(id),
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
SELECT s.id, s.raw_stroke_id, s.start_index, s.end_index,
       e.page_id, e.style_id, e.offset_x, e.offset_y, e.paint_order,
       t.color, t.line_width, r.data_version, r.data_json
FROM latest_shape_states e
JOIN shapes s ON s.id = e.shape_id
JOIN stroke_events r ON r.id = s.raw_stroke_id
JOIN styles t ON t.id = e.style_id
WHERE e.visible = 1;
