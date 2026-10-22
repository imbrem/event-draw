import type { Page, ViewBox } from './model.ts';

export const DEFAULT_PAGE_VIEW: Readonly<ViewBox> = { x: 0, y: 0, width: 1000, height: 1200 };
const DEFAULT_BOARD_VIEW: Readonly<ViewBox> = { x: 0, y: 0, width: 1000, height: 750 };

export const PAGE_PRESETS = [
  { id: 'a4', name: 'A4', label: 'A4 portrait', width: 595, height: 842 },
  { id: 'letter', name: 'Letter', label: 'US Letter', width: 612, height: 792 },
  { id: 'landscape', name: 'Landscape', label: 'A4 landscape', width: 842, height: 595 },
  { id: 'square', name: 'Square', label: 'Square', width: 1000, height: 1000 },
  { id: 'whiteboard', name: 'Whiteboard', label: 'Infinite whiteboard', width: null, height: null },
] as const;

/** Viewports are disposable UI state, separate from persisted page content. */
export class PageViews {
  private boards = new Map<number, ViewBox>();

  get(page?: Page): ViewBox {
    if (!page) return { ...DEFAULT_PAGE_VIEW };
    if (page.kind === 'whiteboard') return this.boards.get(page.id) ?? { ...DEFAULT_BOARD_VIEW };
    return { x: 0, y: 0, width: page.width, height: page.height };
  }
  pan(page: Page, view: ViewBox) {
    if (page.kind === 'whiteboard') this.boards.set(page.id, view);
  }
  zoom(page: Page, factor: number) {
    const view = this.get(page), width = view.width * factor;
    if (page.kind !== 'whiteboard' || width < 50 || width > 1e7) return;
    this.boards.set(page.id, {
      x: view.x + view.width * (1 - factor) / 2, y: view.y + view.height * (1 - factor) / 2,
      width, height: view.height * factor,
    });
  }
  reset(pageId: number) { this.boards.delete(pageId); }
  clear() { this.boards.clear(); }
}
