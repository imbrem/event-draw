import { identifyObject } from './identity.ts';
import type { ObjectInput, PageObject } from '../model.ts';
import { insertRow, scalar, transaction, type Row, type SqlDatabase } from './sql.ts';

export class ObjectStore {
  private db: SqlDatabase;
  private event: (kind: string, pageId: number) => number;
  constructor(db: SqlDatabase, event: (kind: string, pageId: number) => number) {
    this.db = db;
    this.event = event;
  }
  visible(): PageObject[] {
    return this.db.all('SELECT * FROM visible_objects ORDER BY paint_order, id') as unknown as PageObject[];
  }
  set(input: ObjectInput) {
    const json = JSON.stringify(input.data);
    if (!input.format || input.format.length > 100 || !json || json.length > 1_000_000)
      throw new Error('Invalid content format or object exceeds 1,000,000 characters');
    if (
      ![input.x, input.y, input.width, input.height, input.rotation].every(Number.isFinite) ||
      input.width <= 0 ||
      input.height <= 0 ||
      input.label.length > 200
    )
      throw new Error('Invalid object placement');
    transaction(this.db, () => {
      if (!this.db.all('SELECT id FROM current_pages WHERE id = ? AND deleted = 0', [input.pageId]).length)
        throw new Error('Page does not exist');
      const previous = input.id
        ? this.visible().find((o) => o.id === input.id && o.page_id === input.pageId)
        : undefined;
      if (input.id && !previous) throw new Error('Object does not exist on this page');
      if (previous && input.sourceShapeIds !== undefined)
        throw new Error('Object provenance is immutable; create a new object for new sources');
      const sources = [...new Set(input.sourceShapeIds ?? [])];
      for (const id of sources)
        if (
          !this.db.all('SELECT id FROM visible_shapes WHERE id = ? AND page_id = ?', [id, input.pageId])
            .length
        )
          throw new Error('Source shape does not exist on this page');
      this.db.exec(
        'INSERT OR IGNORE INTO object_contents (format, data_version, data_json) VALUES (?, 1, ?)',
        [input.format, json],
      );
      const contentId = scalar(
        this.db,
        'SELECT id FROM object_contents WHERE format = ? AND data_version = 1 AND data_json = ?',
        [input.format, json],
      );
      if (!previous) {
        this.db.exec('INSERT INTO page_objects DEFAULT VALUES');
        input = { ...input, id: scalar(this.db, 'SELECT last_insert_rowid()') };
        identifyObject(this.db, 'page_objects', input.id!);
        for (const shapeId of sources)
          insertRow(this.db, 'object_sources', { object_id: input.id!, shape_id: shapeId });
      }
      const state: Row = {
        object_id: input.id!,
        page_id: input.pageId,
        content_id: contentId,
        visible: 1,
        rendered: input.rendered ? 1 : 0,
        x: input.x,
        y: input.y,
        width: input.width,
        height: input.height,
        rotation: input.rotation,
        label: input.label,
        paint_order: previous?.paint_order ?? input.id!,
      };
      if (
        previous &&
        Object.entries(state).every(
          ([key, value]) =>
            key === 'visible' ||
            value === (key === 'object_id' ? previous.id : (previous as unknown as Row)[key]),
        )
      )
        return;
      this.effect(this.event(previous ? 'object.set' : 'object.add', input.pageId), state);
    });
  }
  delete(pageId: number, id: number) {
    transaction(this.db, () => {
      const object = this.visible().find((o) => o.id === id && o.page_id === pageId);
      if (object) this.effect(this.event('object.delete', pageId), this.state(object, false));
    });
  }
  state(object: PageObject, visible = true): Row {
    return {
      object_id: object.id,
      page_id: object.page_id,
      content_id: object.content_id,
      visible: visible ? 1 : 0,
      rendered: object.rendered,
      x: object.x,
      y: object.y,
      width: object.width,
      height: object.height,
      rotation: object.rotation,
      label: object.label,
      paint_order: object.paint_order,
    };
  }
  effect(eventId: number, state: Row) {
    insertRow(this.db, 'app_event_objects', { app_event_id: eventId, ...state });
  }
  undo(eventId: number, target: number) {
    for (const changed of this.db.all('SELECT * FROM app_event_objects WHERE app_event_id = ?', [target])) {
      const previous = this.db.all(
        'SELECT * FROM app_event_objects WHERE object_id = ? AND app_event_id < ? ORDER BY app_event_id DESC LIMIT 1',
        [changed.object_id, target],
      )[0];
      const { app_event_id: _id, ...state } = previous ?? { ...changed, visible: 0 };
      this.effect(eventId, state);
    }
  }
}
