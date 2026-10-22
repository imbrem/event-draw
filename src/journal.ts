import type { CaptureSession, State, StrokeInput, VisibleStroke } from './model.ts';

export type SqlValue = string | number | null | Uint8Array;
export type Row = Record<string, SqlValue>;

/** Adapter implemented by SQLite WASM in browsers and node:sqlite in tests. */
export interface SqlDatabase {
  exec(sql: string, bind?: SqlValue[]): void;
  all(sql: string, bind?: SqlValue[]): Row[];
}

export class Journal {
  private db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.db = db;
  }

  private scalar(sql: string, bind: SqlValue[] = []): number {
    return Number(Object.values(this.db.all(sql, bind)[0])[0]);
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  startSession(session: CaptureSession): number {
    this.db.exec(
      `INSERT INTO capture_sessions
       (started_at, source, time_origin_ms, user_agent, device_pixel_ratio, capabilities_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [session.startedAt, session.source, session.timeOriginMs, session.userAgent,
        session.devicePixelRatio, JSON.stringify(session.capabilities)],
    );
    return this.scalar('SELECT last_insert_rowid()');
  }

  private event(kind: string, data: unknown = {}, undoOf: number | null = null): number {
    this.db.exec(
      'INSERT INTO app_events (occurred_at, kind, data_version, undo_of_event_id, data_json) VALUES (?, ?, 1, ?, ?)',
      [new Date().toISOString(), kind, undoOf, JSON.stringify(data)],
    );
    return this.scalar('SELECT last_insert_rowid()');
  }

  private effect(eventId: number, shapeId: number, show: boolean, order = shapeId): void {
    this.db.exec(
      'INSERT INTO app_event_strokes VALUES (?, ?, ?, ?)',
      [eventId, shapeId, show ? 'show' : 'hide', show ? order : null],
    );
  }

  addStroke(input: StrokeInput, sessionId: number): State {
    return this.transaction(() => {
      this.db.exec(
        `INSERT INTO stroke_events
         (page_id, capture_session_id, created_at, kind, data_version, status, color, width, data_json)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [sessionId, new Date().toISOString(), input.kind, input.dataVersion, input.status,
          input.color, input.width, JSON.stringify(input.data)],
      );
      const shapeId = this.scalar('SELECT last_insert_rowid()');
      const eventId = this.event(input.status === 'complete' ? 'stroke.add' : 'stroke.cancel');
      this.effect(eventId, shapeId, input.status === 'complete');
      return this.state();
    });
  }

  clear(): State {
    return this.transaction(() => {
      const shapes = this.visible();
      if (shapes.length) {
        const eventId = this.event('page.clear');
        for (const shape of shapes) this.effect(eventId, shape.id, false);
      }
      return this.state();
    });
  }

  /** Append inverse membership effects; do not mutate geometry or old edits. */
  undo(): State {
    return this.transaction(() => {
      const target = this.undoTarget();
      if (target === null) return this.state();
      const effects = this.db.all(
        `SELECT e.stroke_event_id,
           (SELECT p.effect FROM app_event_strokes p
            WHERE p.stroke_event_id = e.stroke_event_id AND p.app_event_id < ?
            ORDER BY p.app_event_id DESC LIMIT 1) AS previous_effect,
           (SELECT p.paint_order FROM app_event_strokes p
            WHERE p.stroke_event_id = e.stroke_event_id AND p.app_event_id < ?
            ORDER BY p.app_event_id DESC LIMIT 1) AS previous_order
         FROM app_event_strokes e WHERE e.app_event_id = ?`,
        [target, target, target],
      );
      const eventId = this.event('history.undo', {}, target);
      for (const effect of effects) {
        this.effect(eventId, Number(effect.stroke_event_id), effect.previous_effect === 'show',
          Number(effect.previous_order ?? effect.stroke_event_id));
      }
      return this.state();
    });
  }

  private undoTarget(): number | null {
    const rows = this.db.all(
      `SELECT a.id FROM app_events a
       WHERE a.kind IN ('stroke.add', 'page.clear')
         AND NOT EXISTS (
           SELECT 1 FROM app_events u
           WHERE u.kind = 'history.undo'
             AND u.undo_of_event_id = a.id
         )
       ORDER BY a.id DESC LIMIT 1`,
    );
    return rows.length ? Number(rows[0].id) : null;
  }

  visible(): VisibleStroke[] {
    return this.db.all(
      `SELECT id, page_id, kind, data_version, color, width, paint_order, data_json
       FROM visible_strokes ORDER BY paint_order, id`,
    ) as unknown as VisibleStroke[];
  }

  state(): State {
    return {
      strokes: this.visible(),
      shapeCount: this.scalar('SELECT count(*) FROM stroke_events'),
      eventCount: this.scalar('SELECT count(*) FROM app_events'),
      canUndo: this.undoTarget() !== null,
    };
  }

  /**
   * Build a separate current-state database with identical render inputs.
   * Target has an empty schema. Shape IDs, data and paint order are preserved.
   */
  snapshotInto(target: SqlDatabase): void {
    const targetJournal = new Journal(target);
    targetJournal.transaction(() => {
      for (const page of this.db.all('SELECT * FROM pages')) {
        target.exec('INSERT OR REPLACE INTO pages VALUES (?, ?, ?)',
          [page.id, page.width, page.height]);
      }
      const sessions = this.db.all(
        `SELECT DISTINCT c.* FROM capture_sessions c
         JOIN visible_strokes v ON v.capture_session_id = c.id ORDER BY c.id`,
      );
      for (const s of sessions) {
        target.exec('INSERT INTO capture_sessions VALUES (?, ?, ?, ?, ?, ?, ?)',
          [s.id, s.started_at, s.source, s.time_origin_ms, s.user_agent,
            s.device_pixel_ratio, s.capabilities_json]);
      }
      const eventId = targetJournal.event('history.baseline');
      for (const s of this.db.all('SELECT * FROM visible_strokes ORDER BY paint_order, id')) {
        target.exec('INSERT INTO stroke_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [s.id, s.page_id, s.capture_session_id, s.created_at, s.kind, s.data_version,
            s.status, s.color, s.width, s.data_json]);
        targetJournal.effect(eventId, Number(s.id), true, Number(s.paint_order));
      }
      if (JSON.stringify(this.visible()) !== JSON.stringify(targetJournal.visible())) {
        throw new Error('Snapshot validation failed: visible state changed.');
      }
    });
  }
}
