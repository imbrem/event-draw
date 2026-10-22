import type { FrontendHost, FrontendSnapshot } from '../frontend.ts';

export interface FrontendExtension {
  id: string;
  mount(root: HTMLElement, host: FrontendHost): () => void;
}
/** Trusted, application-installed modules only. Notebook content is never code. */
export class FrontendExtensions {
  private listeners = new Set<(snapshot: FrontendSnapshot) => void>();
  private disposers: (() => void)[] = [];
  constructor(root: HTMLElement, extensions: readonly FrontendExtension[], host: FrontendHost) {
    const ids = new Set<string>();
    for (const extension of extensions) {
      if (ids.has(extension.id)) throw new Error('Duplicate UI extension: ' + extension.id);
      ids.add(extension.id);
      const slot = document.createElement('section');
      slot.dataset.extension = extension.id;
      root.append(slot);
      const subscriptions = new Set<(snapshot: FrontendSnapshot) => void>();
      const cleanup = () => {
        for (const listener of subscriptions) this.listeners.delete(listener);
        slot.remove();
      };
      try {
        const dispose = extension.mount(slot, {
          ...host,
          subscribe: (listener) => {
            subscriptions.add(listener);
            this.listeners.add(listener);
            listener(host.snapshot());
            return () => {
              subscriptions.delete(listener);
              this.listeners.delete(listener);
            };
          },
        });
        this.disposers.push(() => {
          try {
            dispose();
          } finally {
            cleanup();
          }
        });
      } catch (error) {
        cleanup();
        console.error('UI extension mount failed: ' + extension.id, error);
      }
    }
    root.hidden = !extensions.length;
  }
  update(snapshot: FrontendSnapshot) {
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        console.error('UI extension update failed', error);
      }
    }
  }
  close() {
    for (const dispose of this.disposers.splice(0).reverse()) {
      try {
        dispose();
      } catch (error) {
        console.error('UI extension cleanup failed', error);
      }
    }
    this.listeners.clear();
  }
}
