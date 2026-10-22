export type SqlValue = string | number | null | Uint8Array;
export type Row = Record<string, SqlValue>;
export interface SqlDatabase {
  exec(sql: string, bind?: SqlValue[]): void;
  all(sql: string, bind?: SqlValue[]): Row[];
}
export function scalar(db: SqlDatabase, sql: string, bind: SqlValue[] = []): number {
  return Number(Object.values(db.all(sql, bind)[0])[0]);
}
export function transaction<T>(db: SqlDatabase, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
/** Table/column names are internal schema names, never SQL from the viewer. */
export function insertRow(db: SqlDatabase, table: string, row: Row): void {
  const names = [table, ...Object.keys(row)];
  if (names.some((name) => !/^[a-z_]+$/.test(name))) throw new Error('Invalid SQL identifier');
  db.exec('INSERT INTO ' + table + ' (' + Object.keys(row).join(',') + ') VALUES (' +
    Object.keys(row).map(() => '?').join(',') + ')', Object.values(row));
}
export const VIEWER_TABLES = [
  'app_events', 'app_event_shapes', 'shapes', 'styles', 'documents', 'assets', 'pages', 'capture_sessions',
  'stroke_events', 'visible_shapes',
] as const;
export type ViewerTable = typeof VIEWER_TABLES[number];
export interface BrowseResult {
  table: ViewerTable; offset: number; total: number; rows: Row[];
}
