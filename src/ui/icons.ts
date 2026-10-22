/** Inline vectors share the tool icons' geometry and inherit the current color. */
export function outlineIcon(path: string): string {
  return (
    '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" ' +
    'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
    path +
    '</svg>'
  );
}
export const undoIcon = outlineIcon('<path d="m9 14-5-5 5-5M4 9h10a6 6 0 0 1 6 6v3"/>');
export const redoIcon = outlineIcon('<path d="m15 14 5-5-5-5M20 9H10a6 6 0 0 0-6 6v3"/>');
