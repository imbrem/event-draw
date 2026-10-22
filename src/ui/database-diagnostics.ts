import type { DatabaseDiagnostics } from '../storage/diagnostics.ts';
import { formatBytes as bytes } from './status-indicators.ts';

function ratio(n: number, total: number) {
  return n + ' / ' + total + (total ? ' (' + ((100 * n) / total).toFixed(1) + '%)' : ' (n/a)');
}
export function diagnosticsPanel(stats: DatabaseDiagnostics): HTMLElement {
  const panel = document.createElement('section');
  panel.className = 'database-diagnostics';
  panel.setAttribute('aria-label', 'Database diagnostics');
  const heading = document.createElement('h3');
  heading.textContent = 'Database diagnostics · all documents';
  const values = document.createElement('dl');
  const rows = [
    ['SQLite allocation (excludes WAL)', bytes(stats.databaseBytes)],
    ['Ink captures with visible geometry', ratio(stats.visibleRawCaptures, stats.inkCaptures)],
    ['Raw captures used by visible ink', ratio(stats.visibleRawCaptures, stats.rawCaptures)],
    ['Visible shapes', ratio(stats.visibleShapes, stats.shapes)],
    ['App events / shape effects', stats.appEvents + ' / ' + stats.effects],
    [
      'Documents / active pages / deleted pages',
      stats.documents + ' / ' + stats.activePages + ' / ' + stats.deletedPages,
    ],
    ['Stored raw traces / embedded content', bytes(stats.rawBytes) + ' / ' + bytes(stats.assetBytes)],
    [
      'Objects on page / linked notes',
      stats.renderedObjects + ' / ' + (stats.pageObjects - stats.renderedObjects),
    ],
    ['Active boxes', ratio(stats.activeBoxes, stats.boxes)],
    ['Detector runs / failed runs', stats.detectionRuns + ' / ' + stats.failedDetectionRuns],
  ];
  for (const [label, value] of rows) {
    const term = document.createElement('dt'),
      definition = document.createElement('dd');
    term.textContent = label;
    definition.textContent = value;
    values.append(term, definition);
  }
  const note = document.createElement('p');
  note.textContent =
    'A capture counts as visible if any fragment remains, regardless of length. Ink captures are raw IDs referenced by shapes. All raw captures also include eraser, lasso, move and cancelled contacts. A compact export changes the historical denominators. Raw trace and embedded content counts measure payload sizes.';
  panel.append(heading, values, note);
  return panel;
}
