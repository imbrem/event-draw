import type { Page, PageObject, ViewBox } from './model.ts';

export type BlankPageLayout = 'fixed' | 'note';
export const NOTE_PAGE = { width: 1000, height: 1600, chunk: 800, margin: 320 } as const;

/** A writing note is an ordinary blank page with an extensible layout hint. */
export function isWritingNote(page?: Page): boolean {
  if (page?.kind !== 'page' || page.source_kind !== 'blank') return false;
  try {
    return JSON.parse(page.source_json)?.layout === 'note';
  } catch {
    return false;
  }
}

export function noteHeight(height: number, bottom: number): number {
  return Math.max(height, Math.ceil((bottom + NOTE_PAGE.margin) / NOTE_PAGE.chunk) * NOTE_PAGE.chunk);
}

export function contentBottom(
  ink: ViewBox | null,
  objects: readonly Pick<PageObject, 'rendered' | 'y' | 'width' | 'height' | 'rotation'>[],
): number {
  let bottom = ink ? ink.y + ink.height : 0;
  for (const o of objects) {
    if (!o.rendered) continue;
    const extent = (Math.abs(Math.sin(o.rotation)) * o.width + Math.abs(Math.cos(o.rotation)) * o.height) / 2;
    bottom = Math.max(bottom, o.y + o.height / 2 + extent);
  }
  return bottom;
}
