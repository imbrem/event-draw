/** An implementation ID is immutable within a host. Changed code needs a new
 * version/CID; replacing a plugin must never silently change a saved policy.
 */
export class PluginRegistry<T> {
  private implementations = new Map<string, T>();
  set(id: string, implementation: T): this {
    if (!id || this.implementations.has(id)) throw new Error('Plugin ID already registered or empty: ' + id);
    this.implementations.set(id, implementation); return this;
  }
  get(id: string): T | undefined { return this.implementations.get(id); }
  [Symbol.iterator]() { return this.implementations[Symbol.iterator](); }
}
