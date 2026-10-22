export type SqlValue = string | number | null | Uint8Array;
export type Row = Record<string, SqlValue>;
export interface SqlDatabase {
  exec(sql: string, bind?: SqlValue[]): void;
  all(sql: string, bind?: SqlValue[]): Row[];
}
export function scalar(db: SqlDatabase, sql: string, bind: SqlValue[] = []): number {
  return Number(Object.values(db.all(sql, bind)[0])[0]);
}
const transactionDepth = new WeakMap<SqlDatabase, number>();
export function transaction<T>(db: SqlDatabase, work: () => T): T {
  const depth = transactionDepth.get(db) ?? 0,
    savepoint = 'nested_' + depth;
  db.exec(depth ? 'SAVEPOINT ' + savepoint : 'BEGIN IMMEDIATE');
  transactionDepth.set(db, depth + 1);
  try {
    const result = work();
    db.exec(depth ? 'RELEASE ' + savepoint : 'COMMIT');
    return result;
  } catch (error) {
    db.exec(depth ? 'ROLLBACK TO ' + savepoint : 'ROLLBACK');
    if (depth) db.exec('RELEASE ' + savepoint);
    throw error;
  } finally {
    transactionDepth.set(db, depth);
  }
}
/** Table/column names are internal schema names, never SQL from the viewer. */
export function insertRow(db: SqlDatabase, table: string, row: Row): void {
  const names = [table, ...Object.keys(row)];
  if (names.some((name) => !/^[a-z_]+$/.test(name))) throw new Error('Invalid SQL identifier');
  db.exec(
    'INSERT INTO ' +
      table +
      ' (' +
      Object.keys(row).join(',') +
      ') VALUES (' +
      Object.keys(row)
        .map(() => '?')
        .join(',') +
      ')',
    Object.values(row),
  );
}
export const VIEWER_TABLES = [
  'notebook_metadata',
  'notebook_imports',
  'object_ids',
  'app_events',
  'app_event_shapes',
  'shapes',
  'styles',
  'documents',
  'assets',
  'pages',
  'capture_sessions',
  'asset_refs',
  'blobs',
  'app_event_documents',
  'app_event_pages',
  'current_pages',
  'current_documents',
  'drawn_objects',
  'drawn_raw_ids',
  'stroke_events',
  'ink_policies',
  'ink_outputs',
  'visible_shapes',
  'object_contents',
  'page_objects',
  'object_sources',
  'app_event_objects',
  'visible_objects',
  'detector_policies',
  'detection_runs',
  'detected_boxes',
  'box_shapes',
  'app_event_boxes',
  'active_boxes',
] as const;
export type ViewerTable = (typeof VIEWER_TABLES)[number];
export interface BrowseResult {
  table: ViewerTable;
  offset: number;
  total: number;
  rows: Row[];
}
