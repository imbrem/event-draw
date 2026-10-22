import type { State } from './model.ts';
const collections = ['documents', 'pages', 'shapes', 'objects', 'boxes'] as const;
type Collection = (typeof collections)[number];
type Entity = { id: number };
export type StatePatch = Omit<State, Collection> & {
  patch: true;
  changes: Record<Collection, { upsert: Entity[]; remove: number[] }>;
};
/** Transport caches are disposable; SQLite's event projections stay authoritative. */
export class StateEncoder {
  private previous = new Map<Collection, Map<number, string>>();
  encode(state: State): StatePatch {
    const { documents: _d, pages: _p, shapes: _s, objects: _o, boxes: _b, ...counts } = state;
    const changes = {} as StatePatch['changes'];
    for (const key of collections) {
      const before = this.previous.get(key) ?? new Map(),
        next = new Map<number, string>(),
        upsert: Entity[] = [];
      for (const value of state[key]) {
        const json = JSON.stringify(value);
        next.set(value.id, json);
        if (before.get(value.id) !== json) upsert.push(value);
      }
      changes[key] = { upsert, remove: [...before.keys()].filter((id) => !next.has(id)) };
      this.previous.set(key, next);
    }
    return { ...counts, patch: true, changes };
  }
  clear() {
    this.previous.clear();
  }
}
export class StateDecoder {
  private values = new Map<Collection, Map<number, Entity>>();
  decode(patch: StatePatch): State {
    const { patch: _flag, changes, ...counts } = patch,
      result = { ...counts } as State;
    for (const key of collections) {
      const values = this.values.get(key) ?? new Map<number, Entity>();
      for (const id of changes[key].remove) values.delete(id);
      for (const value of changes[key].upsert) values.set(value.id, value);
      this.values.set(key, values);
      // Match query ordering without reallocating unchanged entity objects.
      const items = [...values.values()] as unknown as State[typeof key];
      if (key === 'pages')
        (items as State['pages']).sort(
          (a, b) => a.document_id - b.document_id || a.page_number - b.page_number || a.id - b.id,
        );
      else if (key === 'shapes' || key === 'objects')
        (items as (State['shapes'][number] | State['objects'][number])[]).sort(
          (a, b) => a.paint_order - b.paint_order || a.id - b.id,
        );
      else items.sort((a, b) => a.id - b.id);
      (result[key] as Entity[]) = items;
    }
    return result;
  }
}
