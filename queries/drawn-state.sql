-- Read-only rendered-state projection. The baseline exporter closes these
-- dependencies into a fresh notebook; never DELETE arbitrary history in place.
SELECT * FROM current_documents ORDER BY id;
SELECT * FROM current_pages WHERE deleted = 0 ORDER BY document_id, page_number;
SELECT * FROM visible_shapes ORDER BY paint_order, id;
SELECT * FROM drawn_objects ORDER BY paint_order, id;

-- Raw captures needed by painted ink, including a whole capture when only a
-- fragment survives. Style, placement, page and edit time remain separate.
SELECT r.* FROM stroke_events r JOIN drawn_raw_ids d ON d.id = r.id ORDER BY r.id;

-- Sources referenced by live page backgrounds and embedded image/SVG objects.
WITH resource_ids(hash) AS (
  SELECT source_hash FROM current_pages WHERE deleted = 0 AND source_hash IS NOT NULL
  UNION
  SELECT json_extract(data_json, '$.hash') FROM drawn_objects WHERE format = 'image/asset'
)
SELECT a.* FROM asset_refs a JOIN resource_ids r USING(hash) ORDER BY a.hash;
