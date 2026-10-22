import type { Document, Page, PdfImport } from '../model.ts';
import { insertRow, scalar, transaction, type SqlDatabase } from './sql.ts';

type RecordEvent = (kind: string, documentId: number, pageId?: number, data?: unknown) => void;
/** Document names and page topology. Content bytes and stroke history stay immutable. */
export class DocumentStore {
  private db: SqlDatabase;
  private record: RecordEvent;
  constructor(db: SqlDatabase, record: RecordEvent) { this.db = db; this.record = record; }
  private lastId() { return scalar(this.db, 'SELECT last_insert_rowid()'); }
  all(): Document[] { return this.db.all('SELECT * FROM documents ORDER BY id') as unknown as Document[]; }
  pages(): Page[] { return this.db.all('SELECT * FROM pages WHERE deleted = 0 ORDER BY document_id, page_number, id') as unknown as Page[]; }
  private document(id: number): Document {
    const document = this.all().find((d) => d.id === id);
    if (!document) throw new Error('Document does not exist');
    return document;
  }
  private blank(id: number) {
    if (this.document(id).pdf_hash) throw new Error('PDF page order is fixed by the source document');
  }
  private uniqueName(proposed: string) {
    const base = proposed.trim().replaceAll('/', '-').replaceAll('\0', '') || 'Document';
    const names = new Set(this.all().map((d) => d.name));
    let name = base, suffix = 2;
    while (names.has(name)) name = base + ' ' + suffix++;
    return name;
  }
  create(name: string): number {
    return transaction(this.db, () => {
      insertRow(this.db, 'documents', { name: this.uniqueName(name), pdf_hash: null });
      const id = this.lastId();
      this.record('document.add', id);
      this.insertPage(id, 1, 1000, 1200);
      return id;
    });
  }
  rename(id: number, name: string) {
    name = name.trim();
    if (name.includes('/') || name.includes('\0')) throw new Error('Document names cannot contain / or NUL');
    transaction(this.db, () => {
      const before = this.document(id).name;
      if (before === name) return;
      if (this.all().some((d) => d.name === name)) throw new Error('That document name is already in use');
      this.db.exec('UPDATE documents SET name = ? WHERE id = ?', [name, id]);
      this.record('document.rename', id, undefined, { before, name });
    });
  }
  importPdf(input: PdfImport): number {
    if (!/^sha256:[0-9a-f]{64}$/.test(input.hash) || !input.bytes.length || !input.pages.length ||
        input.pages.some((p) => !Number.isFinite(p.width) || !Number.isFinite(p.height) || p.width <= 0 || p.height <= 0)) {
      throw new Error('Invalid PDF resource or page dimensions');
    }
    const existing = this.all().find((d) => d.pdf_hash === input.hash);
    if (existing) return existing.id;
    return transaction(this.db, () => {
      insertRow(this.db, 'assets', { hash: input.hash, media_type: 'application/pdf',
        byte_length: input.bytes.length, data: input.bytes });
      insertRow(this.db, 'documents', { name: this.uniqueName(input.name), pdf_hash: input.hash });
      const id = this.lastId();
      input.pages.forEach((size, index) => this.insertPage(id, index + 1, size.width, size.height, index + 1));
      this.record('document.import', id, undefined, { pageCount: input.pages.length });
      return id;
    });
  }
  read(hash: string): Uint8Array {
    const row = this.db.all('SELECT data FROM assets WHERE hash = ?', [hash])[0];
    if (!row) throw new Error('PDF content not found: ' + hash);
    return row.data as Uint8Array;
  }
  private insertPage(documentId: number, number: number, width: number | null, height: number | null, sourcePage: number | null = null) {
    insertRow(this.db, 'pages', { document_id: documentId, page_number: number, source_page: sourcePage,
      deleted: 0, kind: width === null ? 'whiteboard' : 'page', width, height });
    return this.lastId();
  }
  addPage(documentId: number, afterPageId: number, width: number | null, height: number | null): number {
    return transaction(this.db, () => {
      this.blank(documentId);
      const after = this.pages().find((p) => p.document_id === documentId && p.id === afterPageId);
      if (!after) throw new Error('Page does not belong to this document');
      this.db.exec('UPDATE pages SET page_number = page_number + 1 WHERE document_id = ? AND deleted = 0 AND page_number > ?', [documentId, after.page_number]);
      const id = this.insertPage(documentId, after.page_number + 1, width, height);
      this.record('page.add', documentId, id, { afterPageId });
      return id;
    });
  }
  changePage(pageId: number, action: 'earlier' | 'later' | 'delete') {
    transaction(this.db, () => {
      const page = this.pages().find((p) => p.id === pageId);
      if (!page) throw new Error('Page does not exist');
      this.blank(page.document_id);
      const pages = this.pages().filter((p) => p.document_id === page.document_id);
      if (action === 'delete') {
        if (pages.length === 1) throw new Error('Keep at least one page in a blank document');
        this.db.exec('UPDATE pages SET deleted = 1 WHERE id = ?', [pageId]);
        this.db.exec('UPDATE pages SET page_number = page_number - 1 WHERE document_id = ? AND deleted = 0 AND page_number > ?', [page.document_id, page.page_number]);
        this.record('page.delete', page.document_id, pageId);
      } else {
        const other = pages.find((p) => p.page_number === page.page_number + (action === 'earlier' ? -1 : 1));
        if (!other) return;
        this.db.exec('UPDATE pages SET page_number = ? WHERE id = ?', [other.page_number, pageId]);
        this.db.exec('UPDATE pages SET page_number = ? WHERE id = ?', [page.page_number, other.id]);
        this.record('page.move', page.document_id, pageId, { from: page.page_number, to: other.page_number });
      }
    });
  }
}
