import {
  localize, measuredSamples, type CaptureSession, type Gesture, type PdfImport,
  type State, type Style, type VisibleShape,
} from './model.ts';
import { gestureDelta, lassoShapes, planErasure } from './geometry.ts';
import { DocumentStore } from './storage/documents.ts';
import {
  insertRow, scalar, transaction, VIEWER_TABLES,
  type BrowseResult, type Row, type SqlDatabase, type ViewerTable,
} from './storage/sql.ts';
export type { Row, SqlDatabase, SqlValue } from './storage/sql.ts';

interface EventOptions {
  documentId?: number; pageId?: number; rawId?: number; tool?: string; styleId?: number;
  radius?: number; undoable?: boolean; undoOf?: number; data?: unknown;
}
interface Placement {
  id: number; page_id: number; style_id: number; offset_x: number;
  offset_y: number; paint_order: number;
}

/** Semantic operations are atomic and append-only; raw captures never change. */
export class Journal {
  private db: SqlDatabase;
  private documents: DocumentStore;
  constructor(db: SqlDatabase) {
    this.db = db;
    this.documents = new DocumentStore(db, (kind, documentId, pageId, data) => {
      this.event(kind, { documentId, pageId, data });
    });
  }
  private lastId(): number { return scalar(this.db, 'SELECT last_insert_rowid()'); }

  startSession(session: CaptureSession): number {
    insertRow(this.db, 'capture_sessions', {
      started_at: session.startedAt, source: session.source, time_origin_ms: session.timeOriginMs,
      user_agent: session.userAgent, device_pixel_ratio: session.devicePixelRatio,
      capabilities_json: JSON.stringify(session.capabilities),
    });
    return this.lastId();
  }
  private event(kind: string, options: EventOptions = {}): number {
    insertRow(this.db, 'app_events', {
      occurred_at: new Date().toISOString(), kind, document_id: options.documentId ?? null, page_id: options.pageId ?? null,
      raw_stroke_id: options.rawId ?? null, tool: options.tool ?? null,
      style_id: options.styleId ?? null, eraser_radius: options.radius ?? null,
      undoable: options.undoable ? 1 : 0, undo_of_event_id: options.undoOf ?? null,
      data_version: 1, data_json: JSON.stringify(options.data ?? {}),
    });
    return this.lastId();
  }
  private style(style: Style): number {
    this.db.exec('INSERT OR IGNORE INTO styles (color, line_width) VALUES (?, ?)',
      [style.color, style.lineWidth]);
    return scalar(this.db, 'SELECT id FROM styles WHERE color = ? AND line_width = ?',
      [style.color, style.lineWidth]);
  }
  private shape(rawId: number, start: number, end: number): number {
    insertRow(this.db, 'shapes', { raw_stroke_id: rawId, start_index: start, end_index: end });
    return this.lastId();
  }
  private effect(eventId: number, shape: Placement, visible: boolean): void {
    insertRow(this.db, 'app_event_shapes', {
      app_event_id: eventId, shape_id: shape.id, visible: visible ? 1 : 0,
      page_id: shape.page_id, style_id: shape.style_id,
      offset_x: shape.offset_x, offset_y: shape.offset_y, paint_order: shape.paint_order,
    });
  }
  addPage(documentId: number, afterPageId: number, width: number | null, height: number | null): State {
    this.documents.addPage(documentId, afterPageId, width, height); return this.state();
  }
  createDocument(name: string): State { this.documents.create(name); return this.state(); }
  renameDocument(id: number, name: string): State { this.documents.rename(id, name); return this.state(); }
  importPdf(input: PdfImport): State { this.documents.importPdf(input); return this.state(); }
  readPdf(hash: string): Uint8Array { return this.documents.read(hash); }
  changePage(pageId: number, action: 'earlier' | 'later' | 'delete'): State {
    this.documents.changePage(pageId, action); return this.state();
  }
  gesture(input: Gesture, sessionId: number): State {
    return transaction(this.db, () => {
      if (!this.documents.pages().some((p) => p.id === input.pageId)) throw new Error('Page does not exist');
      const { data, origin } = localize(input.data);
      insertRow(this.db, 'stroke_events', {
        capture_session_id: sessionId, data_version: 1, data_json: JSON.stringify(data),
      });
      const rawId = this.lastId();
      if (input.cancelled) {
        this.event('input.cancel', { pageId: input.pageId, rawId, tool: input.tool });
      } else if (input.tool === 'pen') {
        const styleId = this.style(input.style);
        const end = Math.max(0, measuredSamples(data).length - 1);
        const shapeId = this.shape(rawId, 0, end);
        const eventId = this.event('stroke.add', {
          pageId: input.pageId, rawId, tool: input.tool, styleId, undoable: true,
        });
        this.effect(eventId, {
          id: shapeId, page_id: input.pageId, style_id: styleId,
          offset_x: origin.x, offset_y: origin.y, paint_order: shapeId,
        }, true);
      } else if (input.tool === 'lasso') {
        const selected = lassoShapes(this.visible(input.pageId), measuredSamples(input.data));
        const eventId = this.event('selection.lasso', { pageId: input.pageId, rawId, tool: input.tool });
        for (const shape of selected) this.effect(eventId, shape, true);
      } else if (input.tool === 'move-selection') {
        const ids = new Set(input.shapeIds);
        const selected = this.visible(input.pageId).filter((shape) => ids.has(shape.id));
        const delta = gestureDelta(input.data);
        const changed = selected.length > 0 && (delta.x !== 0 || delta.y !== 0);
        const eventId = this.event('selection.move', {
          pageId: input.pageId, rawId, tool: input.tool, undoable: changed,
          data: { deltaX: delta.x, deltaY: delta.y },
        });
        for (const shape of selected) this.effect(eventId, { ...shape,
          offset_x: shape.offset_x + delta.x, offset_y: shape.offset_y + delta.y }, true);
      } else {
        const erasures = planErasure(this.visible(input.pageId),
          measuredSamples(input.data), input.radius, input.tool === 'erase-strokes');
        const eventId = this.event('stroke.erase', {
          pageId: input.pageId, rawId, tool: input.tool, radius: input.radius,
          undoable: erasures.length > 0,
        });
        for (const { shape, ranges } of erasures) {
          this.effect(eventId, shape, false);
          for (const [start, end] of ranges) {
            const id = this.shape(shape.raw_stroke_id, start, end);
            this.effect(eventId, { ...shape, id }, true);
          }
        }
      }
      return this.state();
    });
  }
  clear(pageId: number): State {
    return transaction(this.db, () => {
      const shapes = this.visible(pageId);
      if (shapes.length) {
        const eventId = this.event('page.clear', { pageId, undoable: true });
        for (const shape of shapes) this.effect(eventId, shape, false);
      }
      return this.state();
    });
  }
  deleteShapes(pageId: number, shapeIds: number[]): State {
    return transaction(this.db, () => {
      const ids = new Set(shapeIds);
      const selected = this.visible(pageId).filter((shape) => ids.has(shape.id));
      if (selected.length) {
        const eventId = this.event('selection.delete', { pageId, undoable: true });
        for (const shape of selected) this.effect(eventId, shape, false);
      }
      return this.state();
    });
  }
  private undoCandidates(): Row[] {
    return this.db.all(`
      SELECT a.id, a.page_id FROM app_events a
      WHERE a.undoable = 1 AND NOT EXISTS (
        SELECT 1 FROM app_events u WHERE u.undo_of_event_id = a.id
      ) ORDER BY a.id DESC`);
  }
  undo(pageId: number): State {
    return transaction(this.db, () => {
      const target = this.undoCandidates().find((row) => row.page_id === pageId);
      if (!target) return this.state();
      const eventId = this.event('history.undo', { pageId, undoOf: Number(target.id) });
      for (const changed of this.db.all('SELECT * FROM app_event_shapes WHERE app_event_id = ?', [target.id])) {
        const previous = this.db.all(`
          SELECT * FROM app_event_shapes WHERE shape_id = ? AND app_event_id < ?
          ORDER BY app_event_id DESC LIMIT 1`, [changed.shape_id, target.id])[0];
        const state = previous ?? changed;
        this.effect(eventId, {
          id: Number(changed.shape_id), page_id: Number(state.page_id), style_id: Number(state.style_id),
          offset_x: Number(state.offset_x), offset_y: Number(state.offset_y), paint_order: Number(state.paint_order),
        }, previous ? previous.visible === 1 : false);
      }
      return this.state();
    });
  }
  visible(pageId?: number): VisibleShape[] {
    return this.db.all('SELECT * FROM visible_shapes' + (pageId ? ' WHERE page_id = ?' : '') +
      ' ORDER BY paint_order, id', pageId ? [pageId] : []) as unknown as VisibleShape[];
  }
  state(): State {
    return {
      documents: this.documents.all(), pages: this.documents.pages(),
      shapes: this.visible(),
      rawCount: scalar(this.db, 'SELECT count(*) FROM stroke_events'),
      eventCount: scalar(this.db, 'SELECT count(*) FROM app_events'),
      undoablePages: [...new Set(this.undoCandidates().map((row) => Number(row.page_id)))],
    };
  }
  browse(table: ViewerTable, offset = 0, limit = 25): BrowseResult {
    if (!VIEWER_TABLES.includes(table)) throw new Error('Unknown viewer table');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Invalid pagination');
    }
    const order = table === 'app_event_shapes' ? 'app_event_id DESC, shape_id' : table === 'assets' ? 'hash' : 'id DESC';
    const columns = table === 'assets' ? 'hash, media_type, byte_length' : '*';
    return { table, offset, total: scalar(this.db, 'SELECT count(*) FROM ' + table),
      rows: this.db.all('SELECT ' + columns + ' FROM ' + table + ' ORDER BY ' + order + ' LIMIT ? OFFSET ?', [limit, offset]) };
  }
  related(eventId: number): Row[] {
    return this.db.all(`
      SELECT e.*, s.raw_stroke_id, s.start_index, s.end_index, t.color, t.line_width
      FROM app_event_shapes e JOIN shapes s ON s.id = e.shape_id
      JOIN styles t ON t.id = e.style_id WHERE e.app_event_id = ? ORDER BY e.shape_id`, [eventId]);
  }
  /** Retain raw dependencies, derived ranges, styles and page/placement state. */
  snapshotInto(target: SqlDatabase): void {
    transaction(target, () => {
      target.exec('DELETE FROM pages');
      target.exec('DELETE FROM documents');
      for (const row of this.db.all('SELECT * FROM assets')) insertRow(target, 'assets', row);
      for (const row of this.db.all('SELECT * FROM documents ORDER BY id')) insertRow(target, 'documents', row);
      for (const row of this.db.all('SELECT * FROM pages ORDER BY id')) insertRow(target, 'pages', row);
      const queries: [string, string][] = [
        ['capture_sessions', `SELECT DISTINCT c.* FROM capture_sessions c JOIN stroke_events r
          ON r.capture_session_id = c.id JOIN visible_shapes v ON v.raw_stroke_id = r.id`],
        ['stroke_events', 'SELECT DISTINCT r.* FROM stroke_events r JOIN visible_shapes v ON v.raw_stroke_id = r.id'],
        ['styles', 'SELECT DISTINCT t.* FROM styles t JOIN visible_shapes v ON v.style_id = t.id'],
        ['shapes', 'SELECT s.* FROM shapes s JOIN visible_shapes v ON v.id = s.id'],
      ];
      for (const [table, sql] of queries) for (const row of this.db.all(sql)) insertRow(target, table, row);
      const journal = new Journal(target);
      const baseline = journal.event('history.baseline');
      for (const shape of this.visible()) journal.effect(baseline, shape, true);
      if (JSON.stringify(this.visible()) !== JSON.stringify(journal.visible())) {
        throw new Error('Snapshot validation failed: visible state changed');
      }
    });
  }
}
