/** Disposable UI preference; database identity and page order live in SQLite. */
export class NotebookLocation {
  private key = '';
  use(notebookId: number) {
    this.key = 'event-draw-location-v4:' + notebookId;
    this.saved = '';
  }
  private saved = '';
  read(): { documentId: number; pageId: number } {
    try {
      const legacy = this.key.endsWith(':1') ? localStorage.getItem('event-draw-location-v3') : null;
      const value = JSON.parse(localStorage.getItem(this.key) ?? legacy ?? 'null');
      if (
        Number.isSafeInteger(value?.documentId) &&
        value.documentId > 0 &&
        Number.isSafeInteger(value?.pageId) &&
        value.pageId > 0
      )
        return value;
    } catch {
      /* Storage can be unavailable; navigation still works. */
    }
    return { documentId: 1, pageId: 1 };
  }
  write(documentId: number, pageId: number) {
    const value = JSON.stringify({ documentId, pageId });
    if (!this.key || value === this.saved) return;
    try {
      localStorage.setItem(this.key, value);
      this.saved = value;
    } catch {
      /* This preference must never prevent edits. */
    }
  }
}
