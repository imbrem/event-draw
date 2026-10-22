import type { FrontendSnapshot } from '../frontend.ts';
import type { DatabaseDiagnostics } from '../storage/diagnostics.ts';

export function formatBytes(n: number) {
  return n < 1024
    ? n + ' B'
    : n < 1024 ** 2
      ? (n / 1024).toFixed(1) + ' KiB'
      : (n / 1024 ** 2).toFixed(1) + ' MiB';
}
export interface IndicatorContext extends FrontendSnapshot {
  diagnostics?: DatabaseDiagnostics;
}
export interface StatusIndicator {
  id: string;
  read(context: IndicatorContext): { text: string; title?: string };
}
export const defaultIndicators: readonly StatusIndicator[] = [
  {
    id: 'database',
    read: ({ diagnostics: d }) => ({
      text: 'DB ' + (d ? formatBytes(d.databaseBytes) : '…'),
      title: 'Logical SQLite allocation, including free pages; excludes WAL and browser overhead',
    }),
  },
  {
    id: 'events',
    read: ({ state }) => ({ text: state.eventCount + ' events', title: 'App events in this notebook' }),
  },
  {
    id: 'raw',
    read: ({ state, diagnostics: d }) => ({
      text: state.rawCount + ' traces' + (d ? ' · ' + formatBytes(d.rawBytes) : ''),
      title: 'Raw captures and their encoded payload size',
    }),
  },
];
/** Read-only, throttled diagnostics. Indicator failures cannot break the editor. */
export class StatusIndicators {
  private context: IndicatorContext | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private fetching = false;
  private closed = false;
  private dirty = true;
  private slots: { indicator: StatusIndicator; node: HTMLElement }[];
  constructor(
    root: HTMLElement,
    indicators: readonly StatusIndicator[],
    private load: () => Promise<DatabaseDiagnostics>,
  ) {
    const ids = new Set<string>();
    this.slots = indicators.map((indicator) => {
      if (ids.has(indicator.id)) throw new Error('Duplicate indicator: ' + indicator.id);
      ids.add(indicator.id);
      const node = document.createElement('span');
      node.dataset.indicator = indicator.id;
      root.append(node);
      return { indicator, node };
    });
    root.hidden = !indicators.length;
  }
  update(snapshot: FrontendSnapshot) {
    if (snapshot.state !== this.context?.state) this.dirty = true;
    this.context = { ...snapshot, diagnostics: this.context?.diagnostics };
    this.render();
    this.schedule();
  }
  private render() {
    if (!this.context) return;
    for (const { indicator, node } of this.slots) {
      try {
        const value = indicator.read(this.context);
        node.textContent = value.text;
        node.title = value.title ?? '';
      } catch (error) {
        node.textContent = indicator.id + ' unavailable';
        node.title = String(error);
      }
    }
  }
  private schedule() {
    if (
      this.closed ||
      !this.slots.length ||
      !this.dirty ||
      this.timer ||
      this.fetching ||
      !this.context?.ready ||
      this.context.busy
    )
      return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, 600);
  }
  private async refresh() {
    if (this.closed || !this.context?.ready || this.context.busy) return;
    this.fetching = true;
    this.dirty = false;
    try {
      const diagnostics = await this.load();
      if (!this.closed && this.context) {
        this.context.diagnostics = diagnostics;
        this.render();
      }
    } catch {
      /* Retry on the next state update; persistence errors have their own UI. */
    } finally {
      this.fetching = false;
      this.schedule();
    }
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
  }
}
