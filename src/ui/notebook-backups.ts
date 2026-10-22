/** Keep three recovery snapshots per local notebook, never across identities. */
export class NotebookBackups {
  private async database() {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('event-draw-recovery', 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore('backups', { keyPath: 'id', autoIncrement: true });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async save(bytes: Uint8Array, notebookId: number | null) {
    if (notebookId === null) return;
    const db = await this.database();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('backups', 'readwrite'),
          store = tx.objectStore('backups');
        store.add({ notebookId, createdAt: new Date().toISOString(), bytes });
        const keys = store.getAll();
        keys.onsuccess = () => {
          for (const saved of keys.result.filter((v) => v.notebookId === notebookId).slice(0, -3))
            store.delete(saved.id);
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }
  async latest(notebookId: number | null): Promise<{ bytes: Uint8Array; createdAt: string } | null> {
    const db = await this.database();
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction('backups').objectStore('backups').openCursor(null, 'prev');
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) resolve(null);
          else if (cursor.value.notebookId === notebookId) resolve(cursor.value);
          else cursor.continue();
        };
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  }
}
