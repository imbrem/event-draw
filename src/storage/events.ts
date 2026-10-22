import { insertRow, scalar, type SqlDatabase } from './sql.ts';
import { requireSchemaIdentity } from './schema.ts';
import { initializeIdentity } from './identity.ts';

export interface EventOptions {
  documentId?: number;
  pageId?: number;
  rawId?: number;
  sessionId?: number;
  tool?: string;
  styleId?: number;
  radius?: number;
  policyId?: number;
  cause?: number;
  undoable?: boolean;
  undoOf?: number;
  redoOf?: number;
  data?: unknown;
}
export function recordEvent(db: SqlDatabase, kind: string, options: EventOptions = {}): number {
  insertRow(db, 'app_events', {
    occurred_at: new Date().toISOString(),
    kind,
    document_id: options.documentId ?? null,
    page_id: options.pageId ?? null,
    raw_stroke_id: options.rawId ?? null,
    session_id: options.sessionId ?? null,
    tool: options.tool ?? null,
    style_id: options.styleId ?? null,
    eraser_radius: options.radius ?? null,
    policy_id: options.policyId ?? null,
    cause_event_id: options.cause ?? null,
    undoable: options.undoable ? 1 : 0,
    undo_of_event_id: options.undoOf ?? null,
    redo_of_event_id: options.redoOf ?? null,
    data_version: 1,
    data_json: JSON.stringify(options.data ?? {}),
  });
  return scalar(db, 'SELECT last_insert_rowid()');
}

export function initializeNotebook(db: SqlDatabase) {
  if (!initializeIdentity(db)) return;
  const id = recordEvent(db, 'notebook.create', { data: { schema: requireSchemaIdentity(db) } });
  for (const { id: documentId, ...row } of db.all('SELECT * FROM documents'))
    insertRow(db, 'app_event_documents', { app_event_id: id, document_id: documentId, ...row });
  for (const { id: pageId, ...row } of db.all('SELECT * FROM pages'))
    insertRow(db, 'app_event_pages', { app_event_id: id, page_id: pageId, ...row });
}
