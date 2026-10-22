import type { DatabaseDiagnostics } from '../storage/diagnostics.ts';

function ratio(n: number, total: number) {
  return n + ' / ' + total + (total ? ' (' + (100 * n / total).toFixed(1) + '%)' : ' (n/a)');
}
function bytes(n: number) {
  return n < 1024 ? n + ' B' : n < 1024 * 1024 ? (n / 1024).toFixed(1) + ' KiB' : (n / 1024 / 1024).toFixed(1) + ' MiB';
}
export function diagnosticsPanel(stats: DatabaseDiagnostics): HTMLElement {
  const panel = document.createElement('section');
  panel.className = 'database-diagnostics'; panel.setAttribute('aria-label', 'Database diagnostics');
  const heading = document.createElement('h3'); heading.textContent = 'Database diagnostics · all documents';
  const values = document.createElement('dl');
  const rows = [
    ['Ink captures with visible geometry', ratio(stats.visibleRawCaptures, stats.inkCaptures)],
    ['Raw captures used by visible ink', ratio(stats.visibleRawCaptures, stats.rawCaptures)],
    ['Visible shapes', ratio(stats.visibleShapes, stats.shapes)],
    ['App events / shape effects', stats.appEvents + ' / ' + stats.effects],
    ['Documents / active pages / deleted pages', stats.documents + ' / ' + stats.activePages + ' / ' + stats.deletedPages],
    ['Raw JSON / PDF content', bytes(stats.rawBytes) + ' / ' + bytes(stats.assetBytes)],
  ];
  for (const [label, value] of rows) {
    const term = document.createElement('dt'), definition = document.createElement('dd');
    term.textContent = label; definition.textContent = value; values.append(term, definition);
  }
  const note = document.createElement('p');
  note.textContent = 'A capture counts as visible if any fragment remains, regardless of length. Ink captures are raw IDs referenced by shapes. All raw captures also include eraser, lasso, move and cancelled contacts. A compact export changes the historical denominators. Byte counts are payload sizes, not database file size.';
  panel.append(heading, values, note);
  return panel;
}
