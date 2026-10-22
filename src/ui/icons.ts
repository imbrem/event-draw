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
export const notebooksIcon = outlineIcon(
  '<rect x="6" y="3" width="14" height="18" rx="2"/><path d="M3 7h5M3 12h5M3 17h5M11 8h5M11 12h5"/>',
);

export const composeIcon = outlineIcon('<path d="M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7M15 5l4 4M10 14l1-5 8-8 4 4-8 8-5 1Z"/>');
