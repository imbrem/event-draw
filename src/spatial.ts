import { selectionBounds } from './geometry.ts';
import type { ViewBox, VisibleShape } from './model.ts';
/** Rebuildable grid: objects spanning too many cells use a bounded overflow list. */
export class InkIndex {
  private cells = new Map<string, Set<number>>();
  private bounds = new Map<number, ViewBox>();
  private overflow = new Set<number>();
  private size: number;
  constructor(shapes: VisibleShape[], size = 256) {
    this.size = size;
    for (const shape of shapes) {
      const box = selectionBounds([shape]);
      if (!box) continue;
      this.bounds.set(shape.id, box);
      const keys = this.keys(box);
      if (!keys) {
        this.overflow.add(shape.id);
        continue;
      }
      for (const key of keys) {
        const ids = this.cells.get(key) ?? new Set();
        ids.add(shape.id);
        this.cells.set(key, ids);
      }
    }
  }
  private keys(box: ViewBox): string[] | null {
    const x = Math.floor(box.x / this.size),
      y = Math.floor(box.y / this.size),
      right = Math.floor((box.x + box.width) / this.size),
      bottom = Math.floor((box.y + box.height) / this.size);
    if ((right - x + 1) * (bottom - y + 1) > 4096) return null;
    const keys = [];
    for (let i = x; i <= right; i++) for (let j = y; j <= bottom; j++) keys.push(i + ',' + j);
    return keys;
  }
  query(box: ViewBox): Set<number> {
    const keys = this.keys(box),
      candidates = new Set(this.overflow);
    if (keys) for (const key of keys) for (const id of this.cells.get(key) ?? []) candidates.add(id);
    else for (const id of this.bounds.keys()) candidates.add(id);
    return new Set(
      [...candidates].filter((id) => {
        const b = this.bounds.get(id)!;
        return (
          b.x <= box.x + box.width &&
          b.y <= box.y + box.height &&
          b.x + b.width >= box.x &&
          b.y + b.height >= box.y
        );
      }),
    );
  }
}
