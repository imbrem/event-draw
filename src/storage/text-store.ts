import type { VisibleText } from '../model.ts';
import { insertRow, scalar, transaction, type SqlDatabase } from './sql.ts';

export class TextStore {
  private db: SqlDatabase;
  private event: (pageId: number) => number;
  constructor(db: SqlDatabase, event: (pageId: number) => number) { this.db = db; this.event = event; }
  visible(): VisibleText[] { return this.db.all('SELECT * FROM visible_texts ORDER BY page_id') as unknown as VisibleText[]; }
  set(pageId: number, format: string, source: string) {
    if (!format || format.length > 100 || source.length > 200_000) throw new Error('Invalid text format or note exceeds 200,000 characters');
    transaction(this.db, () => {
      if (!this.db.all('SELECT id FROM pages WHERE id = ? AND deleted = 0', [pageId]).length) throw new Error('Page does not exist');
      const current = this.visible().find((t) => t.page_id === pageId);
      if (current ? current.source === source && current.format === format : !source) return;
      let contentId: number | null = null;
      if (source) {
        this.db.exec('INSERT OR IGNORE INTO text_contents (format, source) VALUES (?, ?)', [format, source]);
        contentId = scalar(this.db, 'SELECT id FROM text_contents WHERE format = ? AND source = ?', [format, source]);
      }
      this.effect(this.event(pageId), pageId, contentId);
    });
  }
  effect(eventId: number, pageId: number, contentId: number | null) {
    insertRow(this.db, 'app_event_texts', { app_event_id: eventId, page_id: pageId, content_id: contentId });
  }
  undo(eventId: number, target: number) {
    for (const changed of this.db.all('SELECT * FROM app_event_texts WHERE app_event_id = ?', [target])) {
      const previous = this.db.all('SELECT content_id FROM app_event_texts WHERE page_id = ? AND app_event_id < ? ORDER BY app_event_id DESC LIMIT 1', [changed.page_id, target])[0];
      this.effect(eventId, Number(changed.page_id), previous ? previous.content_id as number | null : null);
    }
  }
}
