import { NOTE_PAGE, isWritingNote, noteHeight, type BlankPageLayout } from '../note-pages.ts';
import { identifyObject } from './identity.ts';
import type { Document, Page, PdfImport, AssetImport, PageSource } from '../model.ts';
import { insertRow, scalar, transaction, type Row, type SqlDatabase } from './sql.ts';

type RecordEvent = (kind: string, documentId: number, pageId?: number, data?: unknown) => number;
/** Topology mutations append complete effects. Readers use event projections. */
export class DocumentStore {
  private db: SqlDatabase;
  private record: RecordEvent;
  constructor(db: SqlDatabase, record: RecordEvent) {
    this.db = db;
    this.record = record;
  }
  all(): Document[] {
    return this.db.all('SELECT * FROM current_documents ORDER BY id') as unknown as Document[];
  }
  pages(): Page[] {
    return this.db.all(
      'SELECT * FROM current_pages WHERE deleted=0 ORDER BY document_id,page_number,id',
    ) as unknown as Page[];
  }
  private uniqueName(proposed: string) {
    const base = proposed.trim().replaceAll('/', '-').replaceAll('\0', '') || 'Document',
      names = new Set(this.all().map((d) => d.name));
    let name = base,
      suffix = 2;
    while (names.has(name)) name = base + ' ' + suffix++;
    return name;
  }
  private effect(eventId: number, documentId: number) {
    const document = this.db.all('SELECT * FROM documents WHERE id=?', [documentId])[0];
    insertRow(this.db, 'app_event_documents', {
      app_event_id: eventId,
      document_id: documentId,
      name: document.name,
      pdf_hash: document.pdf_hash,
    });
    for (const { id, ...row } of this.db.all('SELECT * FROM pages WHERE document_id=?', [documentId]))
      insertRow(this.db, 'app_event_pages', { app_event_id: eventId, page_id: id, ...row });
  }
  /** Caches can always be repaired from the complete latest event effects. */
  syncCaches() {
    for (const table of ['documents', 'pages'])
      for (const { id, ...row } of this.db.all('SELECT * FROM current_' + table))
        this.db.exec(
          'UPDATE ' +
            table +
            ' SET ' +
            Object.keys(row)
              .map((k) => k + '=?')
              .join(',') +
            ' WHERE id=?',
          [...Object.values(row), id],
        );
  }
  create(name: string, layout: BlankPageLayout = 'note'): number {
    return transaction(this.db, () => {
      insertRow(this.db, 'documents', { name: this.uniqueName(name), pdf_hash: null });
      const id = scalar(this.db, 'SELECT last_insert_rowid()');
      identifyObject(this.db, 'documents', id);
      this.insertPage(id, 1, 1000, layout === 'note' ? NOTE_PAGE.height : 1200, 'blank', null, null, layout);
      this.effect(this.record('document.add', id), id);
      return id;
    });
  }
  rename(id: number, name: string) {
    name = name.trim();
    if (name.includes('/') || name.includes('\0')) throw new Error('Document names cannot contain / or NUL');
    transaction(this.db, () => {
      this.syncCaches();
      const before = this.all().find((d) => d.id === id);
      if (!before) throw new Error('Document does not exist');
      if (before.name === name) return;
      if (this.all().some((d) => d.name === name)) throw new Error('That document name is already in use');
      this.db.exec('UPDATE documents SET name=? WHERE id=?', [name, id]);
      this.effect(this.record('document.rename', id, this.pages().find((p) => p.document_id === id)?.id), id);
    });
  }
  putAsset(hash: string, mediaType: string, bytes: Uint8Array) {
    if (!/^sha256:[0-9a-f]{64}$/.test(hash) || !bytes.length || bytes.length > 200 * 1024 * 1024)
      throw new Error('Invalid resource or resource exceeds 200 MiB');
    this.db.exec('INSERT OR IGNORE INTO asset_refs(hash,media_type,byte_length) VALUES(?,?,?)', [
      hash,
      mediaType,
      bytes.length,
    ]);
    this.db.exec('INSERT OR IGNORE INTO blobs(hash,data) VALUES(?,?)', [hash, bytes]);
  }
  importPdf(input: PdfImport): number {
    if (
      !input.pages.length ||
      input.pages.some(
        (p) => !Number.isFinite(p.width) || !Number.isFinite(p.height) || p.width <= 0 || p.height <= 0,
      )
    )
      throw new Error('Invalid PDF page dimensions');
    const existing = this.all().find((d) => d.pdf_hash === input.hash);
    if (existing) {
      // Re-uploading a known source can hydrate an external-content notebook.
      if (!this.db.all('SELECT hash FROM blobs WHERE hash=?', [input.hash]).length)
        transaction(this.db, () => {
          this.putAsset(input.hash, 'application/pdf', input.bytes);
          this.record('asset.embed', existing.id);
        });
      return existing.id;
    }
    return transaction(this.db, () => {
      this.putAsset(input.hash, 'application/pdf', input.bytes);
      insertRow(this.db, 'documents', { name: this.uniqueName(input.name), pdf_hash: input.hash });
      const id = scalar(this.db, 'SELECT last_insert_rowid()');
      identifyObject(this.db, 'documents', id);
      input.pages.forEach((s, i) => this.insertPage(id, i + 1, s.width, s.height, 'pdf', input.hash, i + 1));
      this.effect(this.record('document.import', id), id);
      return id;
    });
  }
  insertPdf(input: PdfImport, documentId: number, afterPageId: number) {
    if (
      !input.pages.length ||
      input.pages.some(
        (p) => !Number.isFinite(p.width) || !Number.isFinite(p.height) || p.width <= 0 || p.height <= 0,
      )
    )
      throw new Error('Invalid PDF page dimensions');
    transaction(this.db, () => {
      this.syncCaches();
      const after = this.pages().find((p) => p.id === afterPageId && p.document_id === documentId);
      if (!after) throw new Error('Page does not belong to this document');
      this.putAsset(input.hash, 'application/pdf', input.bytes);
      this.db.exec(
        'UPDATE pages SET page_number=page_number+? WHERE document_id=? AND deleted=0 AND page_number>?',
        [input.pages.length, documentId, after.page_number],
      );
      for (const [i, s] of input.pages.entries())
        this.insertPage(documentId, after.page_number + i + 1, s.width, s.height, 'pdf', input.hash, i + 1);
      this.effect(this.record('page.import', documentId, afterPageId), documentId);
    });
  }
  importAsset(input: AssetImport): number {
    return transaction(this.db, () => {
      this.syncCaches();
      const after = this.pages().find(
        (p) => p.id === input.afterPageId && p.document_id === input.documentId,
      );
      if (!after) throw new Error('Page does not belong to this document');
      if (
        !Number.isFinite(input.width) ||
        !Number.isFinite(input.height) ||
        input.width <= 0 ||
        input.height <= 0
      )
        throw new Error('Invalid image dimensions');
      this.putAsset(input.hash, input.mediaType, input.bytes);
      this.db.exec(
        'UPDATE pages SET page_number=page_number+1 WHERE document_id=? AND deleted=0 AND page_number>?',
        [input.documentId, after.page_number],
      );
      const id = this.insertPage(
        input.documentId,
        after.page_number + 1,
        input.width,
        input.height,
        input.mediaType === 'image/svg+xml' ? 'svg' : 'image',
        input.hash,
      );
      this.effect(this.record('page.import', input.documentId, id), input.documentId);
      return id;
    });
  }
  read(hash: string): Uint8Array {
    if (!this.db.all("SELECT name FROM sqlite_schema WHERE type='table' AND name='blobs'").length)
      throw new Error('Content not embedded; supply an external content backend: ' + hash);
    const row = this.db.all('SELECT data FROM blobs WHERE hash=?', [hash])[0];
    if (!row) throw new Error('Content not found or not embedded: ' + hash);
    return row.data as Uint8Array;
  }
  setPageSource(pageId: number, source: PageSource) {
    if (
      !source.source_kind ||
      source.source_kind.length > 100 ||
      typeof JSON.parse(source.source_json) !== 'object' ||
      (source.source_page !== null && (!Number.isSafeInteger(source.source_page) || source.source_page < 1))
    )
      throw new Error('Invalid page source');
    transaction(this.db, () => {
      this.syncCaches();
      const page = this.pages().find((p) => p.id === pageId);
      if (!page) throw new Error('Page does not exist');
      this.db.exec('UPDATE pages SET source_kind=?,source_hash=?,source_page=?,source_json=? WHERE id=?', [
        source.source_kind,
        source.source_hash,
        source.source_page,
        source.source_json,
        pageId,
      ]);
      this.effect(this.record('page.source', page.document_id, pageId), page.document_id);
    });
  }
  private insertPage(
    documentId: number,
    number: number,
    width: number | null,
    height: number | null,
    sourceKind = 'blank',
    sourceHash: string | null = null,
    sourcePage: number | null = null,
    layout: BlankPageLayout = 'fixed',
  ) {
    if (
      width !== null &&
      (!Number.isFinite(width) || !height || !Number.isFinite(height) || width <= 0 || height <= 0)
    )
      throw new Error('Invalid page dimensions');
    insertRow(this.db, 'pages', {
      document_id: documentId,
      page_number: number,
      source_page: sourcePage,
      source_kind: sourceKind,
      source_hash: sourceHash,
      source_json: layout === 'note' ? JSON.stringify({ layout }) : '{}',
      deleted: 0,
      kind: width === null ? 'whiteboard' : 'page',
      width,
      height,
    });
    const id = scalar(this.db, 'SELECT last_insert_rowid()');
    identifyObject(this.db, 'pages', id);
    return id;
  }
  addPage(
    documentId: number,
    afterPageId: number,
    width: number | null,
    height: number | null,
    layout: BlankPageLayout = 'fixed',
  ): number {
    return transaction(this.db, () => {
      this.syncCaches();
      const after = this.pages().find((p) => p.document_id === documentId && p.id === afterPageId);
      if (!after) throw new Error('Page does not belong to this document');
      this.db.exec(
        'UPDATE pages SET page_number=page_number+1 WHERE document_id=? AND deleted=0 AND page_number>?',
        [documentId, after.page_number],
      );
      const id = this.insertPage(
        documentId,
        after.page_number + 1,
        width,
        height,
        'blank',
        null,
        null,
        layout,
      );
      this.effect(this.record('page.add', documentId, id, { afterPageId }), documentId);
      return id;
    });
  }
  /** Auto-growth belongs to the originating edit, including its undo boundary. */
  growNote(pageId: number, bottom?: number, eventId?: number) {
    const page = this.pages().find((p) => p.id === pageId);
    if (!page || page.kind !== 'page' || !isWritingNote(page)) return;
    const height = bottom === undefined ? page.height + NOTE_PAGE.chunk : noteHeight(page.height, bottom);
    if (height === page.height) return;
    this.syncCaches();
    this.db.exec('UPDATE pages SET height=? WHERE id=?', [height, pageId]);
    this.effect(eventId ?? this.record('page.resize', page.document_id, pageId), page.document_id);
  }
  changePage(pageId: number, action: 'earlier' | 'later' | 'delete') {
    transaction(this.db, () => {
      this.syncCaches();
      const page = this.pages().find((p) => p.id === pageId);
      if (!page) throw new Error('Page does not exist');
      const pages = this.pages().filter((p) => p.document_id === page.document_id);
      if (action === 'delete') {
        if (pages.length === 1) throw new Error('Keep at least one page in a document');
        this.db.exec('UPDATE pages SET deleted=1 WHERE id=?', [pageId]);
        this.db.exec(
          'UPDATE pages SET page_number=page_number-1 WHERE document_id=? AND deleted=0 AND page_number>?',
          [page.document_id, page.page_number],
        );
      } else {
        const other = pages.find((p) => p.page_number === page.page_number + (action === 'earlier' ? -1 : 1));
        if (!other) return;
        this.db.exec('UPDATE pages SET page_number=? WHERE id=?', [other.page_number, pageId]);
        this.db.exec('UPDATE pages SET page_number=? WHERE id=?', [page.page_number, other.id]);
      }
      this.effect(
        this.record('page.' + (action === 'delete' ? 'delete' : 'move'), page.document_id, pageId),
        page.document_id,
      );
    });
  }
}
