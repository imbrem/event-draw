PRAGMA foreign_keys = ON;
PRAGMA user_version = 1;

CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY,
  width REAL NOT NULL CHECK (width > 0),
  height REAL NOT NULL CHECK (height > 0)
) STRICT;
INSERT OR IGNORE INTO pages VALUES (1, 1000.0, 1200.0);

CREATE TABLE IF NOT EXISTS capture_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  source TEXT NOT NULL,
  time_origin_ms REAL NOT NULL,
  user_agent TEXT NOT NULL,
  device_pixel_ratio REAL NOT NULL,
  capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json))
) STRICT;

-- One immutable shape per row. JSON holds drawing/capture data only.
-- "stroke_events" is the requested name; these are shape records, not edits.
CREATE TABLE IF NOT EXISTS stroke_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL REFERENCES pages(id),
  capture_session_id INTEGER REFERENCES capture_sessions(id),
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  data_version INTEGER NOT NULL CHECK (data_version > 0),
  status TEXT NOT NULL CHECK (status IN ('complete', 'cancelled')),
  color TEXT NOT NULL,
  width REAL NOT NULL CHECK (width > 0),
  data_json TEXT NOT NULL CHECK (json_valid(data_json))
) STRICT;

CREATE TABLE IF NOT EXISTS app_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  data_version INTEGER NOT NULL CHECK (data_version > 0),
  undo_of_event_id INTEGER REFERENCES app_events(id),
  data_json TEXT NOT NULL CHECK (json_valid(data_json))
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS one_undo_per_event
  ON app_events(undo_of_event_id) WHERE undo_of_event_id IS NOT NULL;

-- One app event can hide/show many shapes: add, erase, split, replace, baseline.
CREATE TABLE IF NOT EXISTS app_event_strokes (
  app_event_id INTEGER NOT NULL REFERENCES app_events(id),
  stroke_event_id INTEGER NOT NULL REFERENCES stroke_events(id),
  effect TEXT NOT NULL CHECK (effect IN ('show', 'hide')),
  paint_order INTEGER,
  PRIMARY KEY (app_event_id, stroke_event_id),
  CHECK ((effect = 'show' AND paint_order IS NOT NULL)
      OR (effect = 'hide' AND paint_order IS NULL))
) STRICT;
CREATE INDEX IF NOT EXISTS stroke_effect_history
  ON app_event_strokes(stroke_event_id, app_event_id DESC);

-- The most recent membership effect wins; IDs supply order, never wall clocks.
CREATE VIEW IF NOT EXISTS visible_strokes AS
SELECT s.*, e.paint_order
FROM stroke_events AS s
JOIN app_event_strokes AS e ON e.stroke_event_id = s.id
WHERE e.effect = 'show'
  AND NOT EXISTS (
    SELECT 1 FROM app_event_strokes AS later
    WHERE later.stroke_event_id = e.stroke_event_id
      AND later.app_event_id > e.app_event_id
  );
