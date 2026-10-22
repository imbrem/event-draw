/** Three recovery snapshots survive replacing the OPFS working notebook. */
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
  async save(bytes: Uint8Array) {
    const db = await this.database();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('backups', 'readwrite'),
          store = tx.objectStore('backups');
        store.add({ createdAt: new Date().toISOString(), bytes });
        const keys = store.getAllKeys();
        keys.onsuccess = () => {
          for (const key of keys.result.slice(0, -3)) store.delete(key);
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }
  async latest(): Promise<{ bytes: Uint8Array; createdAt: string } | null> {
    const db = await this.database();
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction('backups').objectStore('backups').openCursor(null, 'prev');
        request.onsuccess = () => resolve(request.result?.value ?? null);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  }
}
