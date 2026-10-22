/** Disposable UI preference; database identity and page order live in SQLite. */
export class NotebookLocation {
  private key = 'event-draw-location-v3';
  private saved = '';
  read(): { documentId: number; pageId: number } {
    try {
      const value = JSON.parse(localStorage.getItem(this.key) ?? 'null');
      if (Number.isSafeInteger(value?.documentId) && value.documentId > 0 &&
          Number.isSafeInteger(value?.pageId) && value.pageId > 0) return value;
    } catch { /* Storage can be unavailable; navigation still works. */ }
    return { documentId: 1, pageId: 1 };
  }
  write(documentId: number, pageId: number) {
    const value = JSON.stringify({ documentId, pageId });
    if (value === this.saved) return;
    try { localStorage.setItem(this.key, value); this.saved = value; }
    catch { /* This preference must never prevent edits. */ }
  }
}
