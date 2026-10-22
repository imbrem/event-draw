import {
  localize, measuredSamples, type CaptureSession, type Gesture, type PdfImport,
  type State, type Style, type VisibleShape,
} from './model.ts';
import { gestureDelta, planErasure } from './geometry.ts';
import { DocumentStore } from './storage/documents.ts';
import { databaseDiagnostics } from './storage/diagnostics.ts';
import { InkStore } from './storage/ink-store.ts';
import { TextStore } from './storage/text-store.ts';
import { interactionPolicies, type InteractionPolicies, DEFAULT_LASSO, DEFAULT_TOUCH } from './interactions.ts';
import { DEFAULT_INK_POLICY, inkPointAt, outputIndex, type InkOutput, type InkPolicy, type InkProcessors } from './ink.ts';
import {
  insertRow, scalar, transaction, VIEWER_TABLES,
  type BrowseResult, type Row, type SqlDatabase, type ViewerTable,
} from './storage/sql.ts';
export type { Row, SqlDatabase, SqlValue } from './storage/sql.ts';

interface EventOptions {
  documentId?: number; pageId?: number; rawId?: number; tool?: string; styleId?: number;
  radius?: number; policyId?: number; undoable?: boolean; undoOf?: number; data?: unknown;
}
interface Placement {
  id: number; page_id: number; style_id: number; offset_x: number;
  offset_y: number; paint_order: number;
}

/** Semantic operations are atomic and append-only; raw captures never change. */
export class Journal {
  private db: SqlDatabase;
  private documents: DocumentStore;
  private ink: InkStore;
  private text: TextStore;
  private interactions: InteractionPolicies;
  constructor(db: SqlDatabase, processors?: InkProcessors, interactions = interactionPolicies) {
    this.db = db;
    this.ink = new InkStore(db, processors);
    this.interactions = interactions;
    this.text = new TextStore(db, (pageId) => this.event('text.set', { pageId, undoable: true }));
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
      policy_id: options.policyId ?? null,
      undoable: options.undoable ? 1 : 0, undo_of_event_id: options.undoOf ?? null,
      data_version: 1, data_json: JSON.stringify(options.data ?? {}),
    });
    return this.lastId();
  }
  private style(style: Style): number {
    const values = [style.color, style.lineWidth, style.opacity ?? 1, style.blendMode ?? 'source-over'];
    this.db.exec('INSERT OR IGNORE INTO styles (color, line_width, opacity, blend_mode) VALUES (?, ?, ?, ?)', values);
    return scalar(this.db, 'SELECT id FROM styles WHERE color = ? AND line_width = ? AND opacity = ? AND blend_mode = ?', values);
  }
  private shape(outputId: number, start: number, end: number): number {
    insertRow(this.db, 'shapes', { output_id: outputId, start_index: start, end_index: end });
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
  setText(pageId: number, format: string, source: string): State { this.text.set(pageId, format, source); return this.state(); }
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
      } else if (input.tool === 'pen' || input.tool === 'highlighter') {
        const styleId = this.style(input.style);
        const { id: outputId, policyId, output } = this.ink.output(rawId, data, input.policy ?? DEFAULT_INK_POLICY);
        const accepted = output.points.length > 0;
        const eventId = this.event(accepted ? 'stroke.add' : 'input.reject', {
          pageId: input.pageId, rawId, tool: input.tool, styleId, policyId, undoable: accepted,
          data: { outputId, reason: output.rejected },
        });
        if (accepted) {
          const shapeId = this.shape(outputId, 0, output.points.length - 1);
          this.effect(eventId, {
            id: shapeId, page_id: input.pageId, style_id: styleId,
            offset_x: origin.x, offset_y: origin.y, paint_order: shapeId,
          }, true);
        }
      } else if (input.tool === 'lasso') {
        const shapes = this.visible(input.pageId), ids = new Set(this.interactions.select(shapes, measuredSamples(input.data), input.interaction));
        const selected = shapes.filter((s) => ids.has(s.id));
        const eventId = this.event('selection.lasso', { pageId: input.pageId, rawId, tool: input.tool, data: { policy: input.interaction ?? DEFAULT_LASSO } });
        for (const shape of selected) this.effect(eventId, shape, true);
      } else if (input.tool === 'restyle') {
        const shapes = this.visible(input.pageId);
        const edits = this.interactions.touch({ shapes, path: measuredSamples(input.data), radius: input.radius, style: input.style }, input.interaction);
        const eventId = this.event('shape.touch', { pageId: input.pageId, rawId, tool: input.tool, undoable: edits.length > 0,
          data: { policy: input.interaction ?? DEFAULT_TOUCH } });
        const effects = new Map(edits.map((edit) => [edit.shapeId, edit]));
        for (const shape of shapes) {
          const edit = effects.get(shape.id);
          if (edit) this.effect(eventId, { ...shape, style_id: this.style(edit.style) }, true);
        }
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
            const id = this.shape(shape.output_id, start, end);
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
  reprocess(pageId: number, shapeIds: number[], policy: InkPolicy): State {
    return transaction(this.db, () => {
      const ids = new Set(shapeIds), selected = this.visible(pageId).filter((s) => ids.has(s.id));
      let eventId = 0;
      for (const shape of selected) {
        const { id, policyId, output } = this.ink.output(shape.raw_stroke_id, JSON.parse(shape.data_json), policy);
        if (id === shape.output_id) continue;
        if (!eventId) eventId = this.event('ink.reprocess', { pageId, policyId, undoable: true });
        this.effect(eventId, shape, false);
        if (!output.points.length) continue;
        const previous = (JSON.parse(shape.output_json) as InkOutput).points;
        const from = inkPointAt(previous, shape.start_index).sourceIndex, to = inkPointAt(previous, shape.end_index).sourceIndex;
        // A plugin may discard endpoints. Do not extend the retained source range.
        if (from > output.points.at(-1)!.sourceIndex || to < output.points[0].sourceIndex) continue;
        const next = this.shape(id, outputIndex(output.points, from), outputIndex(output.points, to));
        this.effect(eventId, { ...shape, id: next }, true);
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
      this.text.undo(eventId, Number(target.id));
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
      texts: this.text.visible(),
      rawCount: scalar(this.db, 'SELECT count(*) FROM stroke_events'),
      eventCount: scalar(this.db, 'SELECT count(*) FROM app_events'),
      undoablePages: [...new Set(this.undoCandidates().map((row) => Number(row.page_id)))],
    };
  }
  diagnostics() { return databaseDiagnostics(this.db); }
  browse(table: ViewerTable, offset = 0, limit = 25): BrowseResult {
    if (!VIEWER_TABLES.includes(table)) throw new Error('Unknown viewer table');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Invalid pagination');
    }
    const order = table === 'app_event_shapes' ? 'app_event_id DESC, shape_id' : table === 'app_event_texts' ? 'app_event_id DESC, page_id' :
      table === 'visible_texts' ? 'page_id' : table === 'assets' ? 'hash' : 'id DESC';
    const columns = table === 'assets' ? 'hash, media_type, byte_length' : '*';
    return { table, offset, total: scalar(this.db, 'SELECT count(*) FROM ' + table),
      rows: this.db.all('SELECT ' + columns + ' FROM ' + table + ' ORDER BY ' + order + ' LIMIT ? OFFSET ?', [limit, offset]) };
  }
  related(eventId: number): Row[] {
    return this.db.all(`
      SELECT e.*, o.raw_stroke_id, s.output_id, s.start_index, s.end_index, t.color, t.line_width
      FROM app_event_shapes e JOIN shapes s ON s.id = e.shape_id
      JOIN ink_outputs o ON o.id = s.output_id
      JOIN styles t ON t.id = e.style_id WHERE e.app_event_id = ? ORDER BY e.shape_id`, [eventId]);
  }
  outputs(rawId: number): Row[] {
    return this.db.all(`SELECT o.*, p.config_json FROM ink_outputs o JOIN ink_policies p ON p.id = o.policy_id
      WHERE o.raw_stroke_id = ? ORDER BY o.id DESC`, [rawId]);
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
        ['ink_policies', 'SELECT DISTINCT p.* FROM ink_policies p JOIN ink_outputs o ON o.policy_id = p.id JOIN visible_shapes v ON v.output_id = o.id'],
        ['ink_outputs', 'SELECT DISTINCT o.* FROM ink_outputs o JOIN visible_shapes v ON v.output_id = o.id'],
        ['shapes', 'SELECT s.* FROM shapes s JOIN visible_shapes v ON v.id = s.id'],
        ['text_contents', 'SELECT DISTINCT c.* FROM text_contents c JOIN visible_texts v ON v.content_id = c.id'],
      ];
      for (const [table, sql] of queries) for (const row of this.db.all(sql)) insertRow(target, table, row);
      const journal = new Journal(target);
      const baseline = journal.event('history.baseline');
      for (const shape of this.visible()) journal.effect(baseline, shape, true);
      for (const text of this.text.visible()) journal.text.effect(baseline, text.page_id, text.content_id);
      if (JSON.stringify(this.visible()) !== JSON.stringify(journal.visible())) {
        throw new Error('Snapshot validation failed: visible state changed');
      }
      if (JSON.stringify(this.text.visible()) !== JSON.stringify(journal.text.visible())) throw new Error('Snapshot validation failed: text changed');
    });
  }
}
