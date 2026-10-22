import type { SqlDatabase } from './sql.ts';

export interface DatabaseDiagnostics {
  rawCaptures: number; inkCaptures: number; visibleRawCaptures: number;
  shapes: number; visibleShapes: number; appEvents: number; effects: number;
  documents: number; activePages: number; deletedPages: number;
  rawBytes: number; assetBytes: number;
}
/** On-demand aggregate queries; no extra metadata is written into raw captures. */
export function databaseDiagnostics(db: SqlDatabase): DatabaseDiagnostics {
  return db.all(`SELECT
    (SELECT count(*) FROM stroke_events) AS rawCaptures,
    (SELECT count(DISTINCT raw_stroke_id) FROM ink_outputs WHERE json_array_length(data_json, '$.points') > 0) AS inkCaptures,
    (SELECT count(DISTINCT raw_stroke_id) FROM visible_shapes) AS visibleRawCaptures,
    (SELECT count(*) FROM shapes) AS shapes,
    (SELECT count(*) FROM visible_shapes) AS visibleShapes,
    (SELECT count(*) FROM app_events) AS appEvents,
    (SELECT count(*) FROM app_event_shapes) AS effects,
    (SELECT count(*) FROM documents) AS documents,
    (SELECT count(*) FROM pages WHERE deleted = 0) AS activePages,
    (SELECT count(*) FROM pages WHERE deleted = 1) AS deletedPages,
    (SELECT coalesce(sum(length(CAST(data_json AS BLOB))), 0) FROM stroke_events) AS rawBytes,
    (SELECT coalesce(sum(byte_length), 0) FROM assets) AS assetBytes`)[0] as unknown as DatabaseDiagnostics;
}
