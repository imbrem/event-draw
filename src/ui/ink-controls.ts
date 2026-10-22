import { inkProcessors, type InkPolicy, type InkProcessors } from '../ink.ts';
import type { Tool, Style } from '../model.ts';

/** Per-contact settings; applying them to existing ink is a separate edit. */
export class InkControls {
  private root: HTMLElement;
  constructor(root: HTMLElement, prefix = '', processors: InkProcessors = inkProcessors) {
    this.root = root;
    root.innerHTML = '<label>Smoothing <select id="smoothing-policy" aria-label="Smoothing policy"></select></label>' +
      '<label>Width <select id="pressure-policy" aria-label="Pressure policy"></select></label>' +
      '<label>Accept <select id="rejection-policy" aria-label="Rejection policy"></select></label>';
    const labels: Record<string, string> = { 'none@1': 'None', 'moving-average@1': 'Moving average', 'pen-pressure@1': 'Pen pressure', 'constant@1': 'Constant', 'pen-only@1': 'Pen only' };
    for (const [id, registry, selected] of [
      ['smoothing-policy', processors.smoothers, 'none@1'], ['pressure-policy', processors.pressures, 'pen-pressure@1'],
      ['rejection-policy', processors.rejectors, 'none@1'],
    ] as const) {
      const select = root.querySelector<HTMLSelectElement>('#' + id)!;
      for (const [key] of registry) select.add(new Option(id === 'rejection-policy' && key === 'none@1' ? 'All contacts' : labels[key] ?? key, key));
      select.value = selected;
    }
    for (const select of root.querySelectorAll('select')) {
      select.dataset.stage = select.id; select.id = prefix + select.id;
      if (prefix) select.setAttribute('aria-label', 'Preview ' + select.getAttribute('aria-label'));
    }
  }
  get value(): InkPolicy {
    const algorithm = (id: string) => ({ id: this.root.querySelector<HTMLSelectElement>('[data-stage="' + id + '"]')!.value, options: {} });
    return { smoothing: algorithm('smoothing-policy'), pressure: algorithm('pressure-policy'), rejection: algorithm('rejection-policy') };
  }
  update(disabled: boolean) { this.root.querySelectorAll('select').forEach((s) => { s.disabled = disabled; }); }
}

export class PaintControls {
  private current: 'pen' | 'highlighter' = 'pen';
  private paints = { pen: { color: '#203b42', width: 3 }, highlighter: { color: '#f3d44e', width: 24 } };
  private color: HTMLInputElement;
  private width: HTMLInputElement;
  constructor(color: HTMLInputElement, width: HTMLInputElement) { this.color = color; this.width = width; }
  select(tool: Tool) {
    if ((tool !== 'pen' && tool !== 'highlighter') || tool === this.current) return;
    this.paints[this.current] = { color: this.color.value, width: Number(this.width.value) };
    this.current = tool; this.color.value = this.paints[tool].color; this.width.value = String(this.paints[tool].width);
  }
  style(tool: Tool): Style {
    return { color: this.color.value, lineWidth: Number(this.width.value), opacity: tool === 'highlighter' ? 0.28 : 1, blendMode: 'source-over' };
  }
}
