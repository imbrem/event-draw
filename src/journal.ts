import { snapshotNotebook, type SnapshotOptions } from './storage/snapshot.ts';
import { recordEvent, initializeNotebook, type EventOptions } from './storage/events.ts';
import { identifyObject } from './storage/identity.ts';
import {
  localize,
  measuredSamples,
  type CaptureSession,
  type Gesture,
  type PdfImport,
  type State,
  type Style,
  type VisibleShape,
  type ObjectInput,
  type AssetImport,
  type ClipboardInk,
  type SelectionTransform,
  type PageSource,
} from './model.ts';
import { gestureDelta, planErasure, selectionBounds } from './geometry.ts';
import { DocumentStore } from './storage/documents.ts';
import { databaseDiagnostics } from './storage/diagnostics.ts';
import { InkStore } from './storage/ink-store.ts';
import { ObjectStore } from './storage/object-store.ts';
import { DetectionStore } from './storage/detection-store.ts';
import type { BoxDetectors } from './detection.ts';
import {
  interactionPolicies,
  type InteractionPolicies,
  DEFAULT_LASSO,
  DEFAULT_TOUCH,
} from './interactions.ts';
import {
  DEFAULT_INK_POLICY,
  inkPointAt,
  outputIndex,
  policyJson,
  type InkOutput,
  type InkPolicy,
  type InkProcessors,
} from './ink.ts';
import {
  insertRow,
  scalar,
  transaction,
  VIEWER_TABLES,
  type BrowseResult,
  type Row,
  type SqlDatabase,
  type ViewerTable,
} from './storage/sql.ts';
export type { Row, SqlDatabase, SqlValue } from './storage/sql.ts';

interface Placement {
  id: number;
  page_id: number;
  style_id: number;
  offset_x: number;
  offset_y: number;
  paint_order: number;
  scale?: number;
  rotation?: number;
}

/** Semantic operations are atomic and append-only; raw captures never change. */
export class Journal {
  private db: SqlDatabase;
  private documents: DocumentStore;
  private ink: InkStore;
  private objects: ObjectStore;
  private detections: DetectionStore;
  private interactions: InteractionPolicies;
  private historyCache: { revision: number; stacks: Map<string, { undo: Row[]; redo: Row[] }> } | null = null;
  constructor(
    db: SqlDatabase,
    processors?: InkProcessors,
    interactions = interactionPolicies,
    detectors?: BoxDetectors,
  ) {
    this.db = db;
    this.ink = new InkStore(db, processors);
    this.interactions = interactions;
    this.objects = new ObjectStore(db, (kind, pageId) => this.event(kind, { pageId, undoable: true }));
    this.detections = new DetectionStore(
      db,
      (kind, pageId, cause, data) => this.event(kind, { pageId, cause, data }),
      detectors,
    );
    this.documents = new DocumentStore(db, (kind, documentId, pageId, data) => {
      return this.event(kind, {
        documentId,
        pageId,
        data,
        undoable: [
          'page.add',
          'page.move',
          'page.delete',
          'page.import',
          'page.source',
          'document.rename',
        ].includes(kind),
      });
    });
  }
  private lastId(): number {
    return scalar(this.db, 'SELECT last_insert_rowid()');
  }

  startSession(session: CaptureSession, kind: 'app.open' | 'notebook.open' = 'app.open'): number {
    return transaction(this.db, () => {
      initializeNotebook(this.db);
      insertRow(this.db, 'capture_sessions', {
        started_at: session.startedAt,
        source: session.source,
        time_origin_ms: session.timeOriginMs,
        user_agent: session.userAgent,
        device_pixel_ratio: session.devicePixelRatio,
        capabilities_json: JSON.stringify(session.capabilities),
      });
      const id = this.lastId();
      this.event(kind, { sessionId: id });
      return id;
    });
  }
  private event(kind: string, options: EventOptions = {}): number {
    this.historyCache = null;
    return recordEvent(this.db, kind, options);
  }
  private style(style: Style): number {
    const values = [style.color, style.lineWidth, style.opacity ?? 1, style.blendMode ?? 'source-over'];
    this.db.exec(
      'INSERT OR IGNORE INTO styles (color, line_width, opacity, blend_mode) VALUES (?, ?, ?, ?)',
      values,
    );
    return scalar(
      this.db,
      'SELECT id FROM styles WHERE color = ? AND line_width = ? AND opacity = ? AND blend_mode = ?',
      values,
    );
  }
  private shape(outputId: number, start: number, end: number): number {
    insertRow(this.db, 'shapes', { output_id: outputId, start_index: start, end_index: end });
    const id = this.lastId();
    identifyObject(this.db, 'shapes', id);
    return id;
  }
  private effect(eventId: number, shape: Placement, visible: boolean): void {
    insertRow(this.db, 'app_event_shapes', {
      app_event_id: eventId,
      shape_id: shape.id,
      visible: visible ? 1 : 0,
      page_id: shape.page_id,
      style_id: shape.style_id,
      offset_x: shape.offset_x,
      offset_y: shape.offset_y,
      scale: shape.scale ?? 1,
      rotation: shape.rotation ?? 0,
      paint_order: shape.paint_order,
    });
  }
  addPage(documentId: number, afterPageId: number, width: number | null, height: number | null): State {
    this.documents.addPage(documentId, afterPageId, width, height);
    return this.state();
  }
  createDocument(name: string): State {
    this.documents.create(name);
    return this.state();
  }
  renameDocument(id: number, name: string): State {
    this.documents.rename(id, name);
    return this.state();
  }
  importPdf(input: PdfImport): State {
    this.documents.importPdf(input);
    return this.state();
  }
  insertPdf(input: PdfImport, documentId: number, afterPageId: number): State {
    this.documents.insertPdf(input, documentId, afterPageId);
    return this.state();
  }
  importAsset(input: AssetImport): State {
    if (input.asObject)
      return transaction(this.db, () => {
        this.documents.putAsset(input.hash, input.mediaType, input.bytes);
        return this.setObject({
          pageId: input.afterPageId,
          format: 'image/asset',
          data: { hash: input.hash, mediaType: input.mediaType },
          rendered: true,
          x: 40,
          y: 40,
          width: Math.min(600, input.width),
          height: (Math.min(600, input.width) * input.height) / input.width,
          rotation: 0,
          label: input.name,
        });
      });
    this.documents.importAsset(input);
    return this.state();
  }
  readPdf(hash: string): Uint8Array {
    return this.documents.read(hash);
  }
  setPageSource(pageId: number, source: PageSource): State {
    this.documents.setPageSource(pageId, source);
    return this.state();
  }
  setObject(input: ObjectInput): State {
    this.objects.set(input);
    return this.state();
  }
  deleteObject(pageId: number, id: number): State {
    this.objects.delete(pageId, id);
    return this.state();
  }
  private detect(pageId: number) {
    this.detections.reconcile(
      pageId,
      this.visible(pageId),
      scalar(this.db, 'SELECT coalesce(max(id), 0) FROM app_events'),
    );
  }
  changePage(pageId: number, action: 'earlier' | 'later' | 'delete'): State {
    return transaction(this.db, () => {
      this.documents.changePage(pageId, action);
      this.detect(pageId);
      return this.state();
    });
  }
  gesture(input: Gesture, sessionId: number): State {
    return transaction(this.db, () => {
      if (!this.documents.pages().some((p) => p.id === input.pageId)) throw new Error('Page does not exist');
      const { data, origin } = localize(input.data);
      insertRow(this.db, 'stroke_events', {
        capture_session_id: sessionId,
        data_version: 1,
        data_json: JSON.stringify(data),
      });
      const rawId = this.lastId();
      if (input.cancelled) {
        this.event('input.cancel', { pageId: input.pageId, rawId, tool: input.tool });
      } else if (input.tool === 'pen' || input.tool === 'highlighter') {
        const styleId = this.style(input.style);
        const {
          id: outputId,
          policyId,
          output,
        } = this.ink.output(rawId, data, input.policy ?? DEFAULT_INK_POLICY);
        const accepted = output.points.length > 0;
        const eventId = this.event(accepted ? 'stroke.add' : 'input.reject', {
          pageId: input.pageId,
          rawId,
          tool: input.tool,
          styleId,
          policyId,
          undoable: accepted,
          data: { outputId, reason: output.rejected },
        });
        if (accepted) {
          const shapeId = this.shape(outputId, 0, output.points.length - 1);
          this.effect(
            eventId,
            {
              id: shapeId,
              page_id: input.pageId,
              style_id: styleId,
              offset_x: origin.x,
              offset_y: origin.y,
              paint_order: shapeId,
            },
            true,
          );
        }
      } else if (input.tool === 'lasso') {
        const shapes = this.visible(input.pageId),
          ids = new Set(this.interactions.select(shapes, measuredSamples(input.data), input.interaction));
        const selected = shapes.filter((s) => ids.has(s.id));
        const eventId = this.event('selection.lasso', {
          pageId: input.pageId,
          rawId,
          tool: input.tool,
          data: { policy: input.interaction ?? DEFAULT_LASSO },
        });
        for (const shape of selected) this.effect(eventId, shape, true);
      } else if (input.tool === 'restyle') {
        const shapes = this.visible(input.pageId);
        const edits = this.interactions.touch(
          { shapes, path: measuredSamples(input.data), radius: input.radius, style: input.style },
          input.interaction,
        );
        const eventId = this.event('shape.touch', {
          pageId: input.pageId,
          rawId,
          tool: input.tool,
          undoable: edits.length > 0,
          data: { policy: input.interaction ?? DEFAULT_TOUCH },
        });
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
          pageId: input.pageId,
          rawId,
          tool: input.tool,
          undoable: changed,
          data: { deltaX: delta.x, deltaY: delta.y },
        });
        for (const shape of selected)
          this.effect(
            eventId,
            { ...shape, offset_x: shape.offset_x + delta.x, offset_y: shape.offset_y + delta.y },
            true,
          );
      } else {
        const erasures = planErasure(
          this.visible(input.pageId),
          measuredSamples(input.data),
          input.radius,
          input.tool === 'erase-strokes',
        );
        const eventId = this.event('stroke.erase', {
          pageId: input.pageId,
          rawId,
          tool: input.tool,
          radius: input.radius,
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
      this.detect(input.pageId);
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
      this.detect(pageId);
      return this.state();
    });
  }
  reprocess(pageId: number, shapeIds: number[], policy: InkPolicy): State {
    return transaction(this.db, () => {
      const ids = new Set(shapeIds),
        selected = this.visible(pageId).filter((s) => ids.has(s.id));
      let eventId = 0;
      for (const shape of selected) {
        const { id, policyId, output } = this.ink.output(
          shape.raw_stroke_id,
          JSON.parse(shape.data_json),
          policy,
        );
        if (id === shape.output_id) continue;
        if (!eventId) eventId = this.event('ink.reprocess', { pageId, policyId, undoable: true });
        this.effect(eventId, shape, false);
        if (!output.points.length) continue;
        const previous = (JSON.parse(shape.output_json) as InkOutput).points;
        const from = inkPointAt(previous, shape.start_index).sourceIndex,
          to = inkPointAt(previous, shape.end_index).sourceIndex;
        // A plugin may discard endpoints. Do not extend the retained source range.
        if (from > output.points.at(-1)!.sourceIndex || to < output.points[0].sourceIndex) continue;
        const next = this.shape(id, outputIndex(output.points, from), outputIndex(output.points, to));
        this.effect(eventId, { ...shape, id: next }, true);
      }
      this.detect(pageId);
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
      this.detect(pageId);
      return this.state();
    });
  }
  private historyStacks() {
    const revision = scalar(this.db, 'SELECT coalesce(max(id),0) FROM app_events');
    if (this.historyCache?.revision === revision) return this.historyCache.stacks;
    const stacks = new Map<string, { undo: Row[]; redo: Row[] }>(),
      operations = new Map<number, Row>();
    const pageDocuments = new Map(
      this.db.all('SELECT id,document_id FROM current_pages').map((r) => [r.id, r.document_id]),
    );
    const scope = (r: Row) => 'd' + (r.document_id ?? pageDocuments.get(r.page_id));
    for (const row of this.db.all(
      'SELECT id,kind,page_id,document_id,undoable,undo_of_event_id,redo_of_event_id FROM app_events ORDER BY id',
    )) {
      if (row.undoable) {
        operations.set(Number(row.id), row);
        const key = scope(row),
          stack = stacks.get(key) ?? { undo: [], redo: [] };
        stack.undo.push(row);
        stack.redo = [];
        stacks.set(key, stack);
      } else if (row.undo_of_event_id || row.redo_of_event_id) {
        const original = operations.get(Number(row.undo_of_event_id ?? row.redo_of_event_id));
        if (!original) continue;
        const stack = stacks.get(scope(original))!;
        if (row.undo_of_event_id) {
          stack.undo = stack.undo.filter((r) => r.id !== original.id);
          stack.redo.push(original);
        } else {
          stack.redo = stack.redo.filter((r) => r.id !== original.id);
          stack.undo.push(original);
        }
      }
    }
    this.historyCache = { revision, stacks };
    return stacks;
  }
  private historyTarget(pageId: number, redo = false, stacks = this.historyStacks()): Row | undefined {
    const documentId = this.db.all('SELECT document_id FROM current_pages WHERE id=?', [pageId])[0]
      ?.document_id;
    return stacks.get('d' + documentId)?.[redo ? 'redo' : 'undo'].at(-1);
  }
  private restoreEffects(eventId: number, target: number, forward: boolean) {
    for (const [table, key, hidden] of [
      ['app_event_shapes', 'shape_id', 'visible'],
      ['app_event_objects', 'object_id', 'visible'],
      ['app_event_pages', 'page_id', 'deleted'],
      ['app_event_documents', 'document_id', ''],
    ] as const) {
      for (const changed of this.db.all('SELECT * FROM ' + table + ' WHERE app_event_id=?', [target])) {
        const previous = forward
          ? changed
          : this.db.all(
              'SELECT * FROM ' +
                table +
                ' WHERE ' +
                key +
                '=? AND app_event_id<? ORDER BY app_event_id DESC LIMIT 1',
              [changed[key], target],
            )[0];
        let state = previous ?? { ...changed, [hidden]: hidden === 'deleted' ? 1 : 0 };
        if (!previous && table === 'app_event_pages' && changed.page_id === 1)
          state = {
            ...changed,
            document_id: 1,
            page_number: 1,
            source_page: null,
            source_kind: 'blank',
            source_hash: null,
            source_json: '{}',
            deleted: 0,
            kind: 'page',
            width: 1000,
            height: 1200,
          };
        if (!previous && table === 'app_event_documents') state = { ...changed, name: '', pdf_hash: null };
        const { app_event_id: _old, ...effect } = state;
        insertRow(this.db, table, { app_event_id: eventId, ...effect });
      }
    }
    this.documents.syncCaches();
  }
  undo(pageId: number): State {
    return this.history(pageId, false);
  }
  redo(pageId: number): State {
    return this.history(pageId, true);
  }
  private history(pageId: number, redo: boolean): State {
    return transaction(this.db, () => {
      const target = this.historyTarget(pageId, redo);
      if (!target) return this.state();
      const eventId = this.event(redo ? 'history.redo' : 'history.undo', {
        pageId,
        ...(redo ? { redoOf: Number(target.id) } : { undoOf: Number(target.id) }),
      });
      this.restoreEffects(eventId, Number(target.id), redo);
      const affected = new Set([
        pageId,
        ...this.db
          .all('SELECT page_id FROM app_event_pages WHERE app_event_id=?', [eventId])
          .map((r) => Number(r.page_id)),
      ]);
      for (const id of affected) this.detect(id);
      return this.state();
    });
  }
  transformShapes(pageId: number, ids: number[], change: SelectionTransform): State {
    return transaction(this.db, () => {
      const shapes = this.visible(pageId).filter((s) => ids.includes(s.id)),
        bounds = selectionBounds(shapes);
      if (!bounds) return this.state();
      const scale = change.scale ?? 1,
        angle = change.rotation ?? 0,
        dx = change.dx ?? 0,
        dy = change.dy ?? 0;
      if (![scale, angle, dx, dy].every(Number.isFinite) || scale < 0.01 || scale > 100)
        throw new Error('Invalid selection transform');
      const center = change.center ?? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      if (![center.x, center.y].every(Number.isFinite)) throw new Error('Invalid transform center');
      const event = this.event('selection.transform', { pageId, undoable: true, data: change }),
        c = Math.cos(angle) * scale,
        s = Math.sin(angle) * scale;
      for (const shape of shapes) {
        const x = shape.offset_x - center.x,
          y = shape.offset_y - center.y;
        this.effect(
          event,
          {
            ...shape,
            offset_x: center.x + c * x - s * y + dx,
            offset_y: center.y + s * x + c * y + dy,
            scale: shape.scale * scale,
            rotation: shape.rotation + angle,
          },
          true,
        );
      }
      this.detect(pageId);
      return this.state();
    });
  }
  copyShapes(pageId: number, ids: number[]): ClipboardInk[] {
    return this.visible(pageId)
      .filter((s) => ids.includes(s.id))
      .map((shape) => ({
        shape,
        data: JSON.parse(shape.data_json),
        policy: JSON.parse(
          String(this.outputs(shape.raw_stroke_id).find((o) => o.id === shape.output_id)!.config_json),
        ),
        session: (this.db.all(
          'SELECT c.* FROM capture_sessions c JOIN stroke_events r ON r.capture_session_id=c.id WHERE r.id=?',
          [shape.raw_stroke_id],
        )[0] ?? null) as ClipboardInk['session'],
      }));
  }
  pasteShapes(pageId: number, items: ClipboardInk[]): State {
    return transaction(this.db, () => {
      if (
        !this.documents.pages().some((p) => p.id === pageId) ||
        !Array.isArray(items) ||
        items.length > 10000 ||
        JSON.stringify(items).length > 32 * 1024 * 1024
      )
        throw new Error('Invalid paste target or size');
      const event = this.event('selection.paste', { pageId, undoable: items.length > 0 });
      for (const item of items) {
        const old = item.shape,
          points = (JSON.parse(old.output_json) as InkOutput).points,
          count = measuredSamples(item.data).length;
        if (
          old.output_version !== 1 ||
          old.data_version !== 1 ||
          !Array.isArray(points) ||
          !points.length ||
          points.some(
            (p, i) =>
              ![p.x, p.y, p.sourceIndex, p.widthFactor].every(Number.isFinite) ||
              p.widthFactor <= 0 ||
              p.widthFactor > 8 ||
              p.sourceIndex < 0 ||
              p.sourceIndex >= count ||
              (i > 0 && p.sourceIndex <= points[i - 1].sourceIndex),
          ) ||
          ![
            old.start_index,
            old.end_index,
            old.offset_x,
            old.offset_y,
            old.scale,
            old.rotation,
            old.line_width,
            old.opacity,
          ].every(Number.isFinite) ||
          old.start_index < 0 ||
          old.end_index < old.start_index ||
          old.end_index > points.length - 1 ||
          old.scale <= 0 ||
          old.line_width <= 0 ||
          old.opacity <= 0 ||
          old.opacity > 1
        )
          throw new Error('Invalid clipboard geometry');
        // Reuse immutable captures/outputs within this notebook; otherwise import
        // the original clock metadata and baked geometry, without rerunning plugins.
        const rawJson = JSON.stringify(item.data),
          config = policyJson(item.policy);
        const existingRaw = this.db.all('SELECT * FROM stroke_events WHERE id=? AND data_json=?', [
          old.raw_stroke_id,
          rawJson,
        ])[0];
        const localSession = existingRaw?.capture_session_id
          ? this.db.all('SELECT * FROM capture_sessions WHERE id=?', [existingRaw.capture_session_id])[0]
          : null;
        const sessionKey = (session: ClipboardInk['session']) =>
          JSON.stringify(
            session
              ? Object.fromEntries(
                  Object.entries(session)
                    .filter(([key]) => key !== 'id')
                    .sort(([a], [b]) => a.localeCompare(b)),
                )
              : null,
          );
        let rawId =
          existingRaw && sessionKey(localSession as ClipboardInk['session']) === sessionKey(item.session)
            ? Number(existingRaw.id)
            : 0;
        if (!rawId) {
          let sourceSession: number | null = null;
          if (item.session) {
            const { id: _id, ...fields } = item.session;
            const allowed = [
              'started_at',
              'source',
              'time_origin_ms',
              'user_agent',
              'device_pixel_ratio',
              'capabilities_json',
            ];
            if (Object.keys(fields).length !== allowed.length || allowed.some((k) => !(k in fields)))
              throw new Error('Invalid capture session');
            insertRow(this.db, 'capture_sessions', fields);
            sourceSession = this.lastId();
          }
          insertRow(this.db, 'stroke_events', {
            capture_session_id: sourceSession,
            data_version: 1,
            data_json: rawJson,
          });
          rawId = this.lastId();
        }
        this.db.exec('INSERT OR IGNORE INTO ink_policies(config_json) VALUES(?)', [config]);
        const policyId = scalar(this.db, 'SELECT id FROM ink_policies WHERE config_json=?', [config]);
        const existing = this.db.all(
          'SELECT id,data_json FROM ink_outputs WHERE raw_stroke_id=? AND policy_id=?',
          [rawId, policyId],
        )[0];
        if (existing && existing.data_json !== old.output_json)
          throw new Error('Clipboard output conflicts with immutable processor version');
        if (!existing)
          insertRow(this.db, 'ink_outputs', {
            raw_stroke_id: rawId,
            policy_id: policyId,
            data_version: 1,
            rejection_reason: null,
            data_json: old.output_json,
          });
        const output = existing ? Number(existing.id) : this.lastId();
        const id = this.shape(output, old.start_index, old.end_index),
          styleId = this.style({
            color: old.color,
            lineWidth: old.line_width,
            opacity: old.opacity,
            blendMode: old.blend_mode,
          });
        this.effect(
          event,
          {
            ...old,
            id,
            page_id: pageId,
            style_id: styleId,
            offset_x: old.offset_x + 24,
            offset_y: old.offset_y + 24,
            paint_order: id,
          },
          true,
        );
      }
      this.detect(pageId);
      return this.state();
    });
  }
  visible(pageId?: number): VisibleShape[] {
    return this.db.all(
      'SELECT * FROM visible_shapes' + (pageId ? ' WHERE page_id = ?' : '') + ' ORDER BY paint_order, id',
      pageId ? [pageId] : [],
    ) as unknown as VisibleShape[];
  }
  state(): State {
    if (!this.db.all('SELECT id FROM notebook_metadata').length)
      transaction(this.db, () => initializeNotebook(this.db));
    const pages = this.documents.pages(),
      stacks = this.historyStacks();
    return {
      documents: this.documents.all(),
      pages,
      shapes: this.visible(),
      objects: this.objects.visible(),
      boxes: this.detections.visible(),
      rawCount: scalar(this.db, 'SELECT count(*) FROM stroke_events'),
      eventCount: scalar(this.db, 'SELECT count(*) FROM app_events'),
      undoablePages: pages.filter((p) => stacks.get('d' + p.document_id)?.undo.length).map((p) => p.id),
      redoablePages: pages.filter((p) => stacks.get('d' + p.document_id)?.redo.length).map((p) => p.id),
    };
  }
  diagnostics() {
    return databaseDiagnostics(this.db);
  }
  browse(table: ViewerTable, offset = 0, limit = 25): BrowseResult {
    if (!VIEWER_TABLES.includes(table)) throw new Error('Unknown viewer table');
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw new Error('Invalid pagination');
    }
    const order =
      table === 'app_event_shapes'
        ? 'app_event_id DESC, shape_id'
        : table === 'app_event_objects'
          ? 'app_event_id DESC, object_id'
          : table === 'app_event_boxes'
            ? 'app_event_id DESC, box_id'
            : table === 'box_shapes'
              ? 'box_id, shape_id'
              : table === 'app_event_pages'
                ? 'app_event_id DESC,page_id'
                : table === 'app_event_documents'
                  ? 'app_event_id DESC,document_id'
                  : table === 'object_sources'
                    ? 'object_id, shape_id'
                    : ['assets', 'asset_refs', 'blobs'].includes(table)
                      ? 'hash'
                      : 'id DESC';
    const columns =
      table === 'assets'
        ? 'hash, media_type, byte_length'
        : table === 'blobs'
          ? 'hash,length(data) AS byte_length'
          : '*';
    return {
      table,
      offset,
      total: scalar(this.db, 'SELECT count(*) FROM ' + table),
      rows: this.db.all('SELECT ' + columns + ' FROM ' + table + ' ORDER BY ' + order + ' LIMIT ? OFFSET ?', [
        limit,
        offset,
      ]),
    };
  }
  related(eventId: number): Row[] {
    return this.db.all(
      `
      SELECT e.*, o.raw_stroke_id, s.output_id, s.start_index, s.end_index, t.color, t.line_width
      FROM app_event_shapes e JOIN shapes s ON s.id = e.shape_id
      JOIN ink_outputs o ON o.id = s.output_id
      JOIN styles t ON t.id = e.style_id WHERE e.app_event_id = ? ORDER BY e.shape_id`,
      [eventId],
    );
  }
  outputs(rawId: number): Row[] {
    return this.db.all(
      `SELECT o.*, p.config_json FROM ink_outputs o JOIN ink_policies p ON p.id = o.policy_id
      WHERE o.raw_stroke_id = ? ORDER BY o.id DESC`,
      [rawId],
    );
  }
  relatedContent(eventId: number) {
    return {
      objects: this.db.all(
        `SELECT e.*, c.format, c.data_json FROM app_event_objects e JOIN object_contents c ON c.id = e.content_id WHERE e.app_event_id = ?`,
        [eventId],
      ),
      boxes: this.db.all(
        `SELECT e.active, b.*, s.shape_id, o.raw_stroke_id FROM app_event_boxes e JOIN detected_boxes b ON b.id = e.box_id
        JOIN box_shapes s ON s.box_id = b.id JOIN shapes g ON g.id = s.shape_id JOIN ink_outputs o ON o.id = g.output_id WHERE e.app_event_id = ? ORDER BY b.id, s.shape_id`,
        [eventId],
      ),
    };
  }
  snapshotInto(target: SqlDatabase, options: SnapshotOptions = {}): void {
    snapshotNotebook(this.db, target, options);
  }
}
