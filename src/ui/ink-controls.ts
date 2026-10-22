import { inkProcessors, type InkPolicy, type InkProcessors } from '../ink.ts';
import type { Tool, Style } from '../model.ts';
import { ColorPalette } from './color-palette.ts';

/** Per-contact settings; applying them to existing ink is a separate edit. */
export class InkControls {
  private root: HTMLElement;
  constructor(root: HTMLElement, prefix = '', processors: InkProcessors = inkProcessors) {
    this.root = root;
    root.innerHTML =
      '<label>Smoothing <select id="smoothing-policy" aria-label="Smoothing policy"></select></label>' +
      '<label>Width <select id="pressure-policy" aria-label="Pressure policy"></select></label>' +
      '<label>Accept <select id="rejection-policy" aria-label="Rejection policy"></select></label>';
    const labels: Record<string, string> = {
      'none@1': 'None',
      'moving-average@1': 'Moving average',
      'pen-pressure@1': 'Pen pressure',
      'constant@1': 'Constant',
      'pen-only@1': 'Pen only',
      'speed-width@1': 'Speed',
      'pressure-speed@1': 'Pressure + speed',
    };
    for (const [id, registry, selected] of [
      ['smoothing-policy', processors.smoothers, 'none@1'],
      ['pressure-policy', processors.pressures, 'pen-pressure@1'],
      ['rejection-policy', processors.rejectors, 'none@1'],
    ] as const) {
      const select = root.querySelector<HTMLSelectElement>('#' + id)!;
      for (const [key] of registry)
        select.add(
          new Option(
            id === 'rejection-policy' && key === 'none@1' ? 'All contacts' : (labels[key] ?? key),
            key,
          ),
        );
      select.value = selected;
    }
    for (const select of root.querySelectorAll('select')) {
      select.dataset.stage = select.id;
      select.id = prefix + select.id;
      if (prefix) select.setAttribute('aria-label', 'Preview ' + select.getAttribute('aria-label'));
    }
    const formula = document.createElement('fieldset');
    formula.className = 'width-formula';
    formula.hidden = true;
    formula.innerHTML = '<legend>Width formula</legend>';
    for (const [key, label, value, min, max, step] of [
      ['pressureWeight', 'Pressure weight', 0.7, 0, 10, 0.1],
      ['speedWeight', 'Speed weight', 0.3, 0, 10, 0.1],
      ['referenceSpeed', 'Reference speed (units/ms)', 0.5, 0.001, 1000, 0.1],
      ['pressureExponent', 'Pressure exponent', 1, 0.1, 8, 0.1],
      ['speedExponent', 'Speed exponent', 1, 0.1, 8, 0.1],
      ['min', 'Minimum factor', 0.35, 0.05, 8, 0.05],
      ['max', 'Maximum factor', 1.65, 0.05, 8, 0.05],
    ] as const) {
      const row = document.createElement('label'),
        input = document.createElement('input');
      row.textContent = label;
      input.type = 'number';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(value);
      input.dataset.option = key;
      input.setAttribute('aria-label', (prefix ? 'Preview ' : '') + label);
      row.append(input);
      formula.append(row);
    }
    for (const [key, label, choices] of [
      [
        'direction',
        'Speed response',
        [
          ['thinner-fast', 'Thinner when faster'],
          ['thicker-fast', 'Thicker when faster'],
        ],
      ],
      [
        'mix',
        'Weighting',
        [
          ['arithmetic', 'Arithmetic'],
          ['geometric', 'Geometric'],
        ],
      ],
    ] as const) {
      const row = document.createElement('label'),
        select = document.createElement('select');
      row.textContent = label;
      select.dataset.option = key;
      select.setAttribute('aria-label', (prefix ? 'Preview ' : '') + label);
      for (const [value, text] of choices) select.add(new Option(text, value));
      row.append(select);
      formula.append(row);
    }
    root.append(formula);
    root.querySelector<HTMLSelectElement>('[data-stage="pressure-policy"]')!.onchange = () => {
      const id = this.value.pressure.id;
      formula.hidden = id !== 'speed-width@1' && id !== 'pressure-speed@1';
    };
  }
  get value(): InkPolicy {
    const algorithm = (id: string) => ({
      id: this.root.querySelector<HTMLSelectElement>('[data-stage="' + id + '"]')!.value,
      options: {},
    });
    const pressure = algorithm('pressure-policy');
    if (pressure.id === 'speed-width@1' || pressure.id === 'pressure-speed@1')
      pressure.options = Object.fromEntries(
        [...this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-option]')].map(
          (input) => [
            input.dataset.option!,
            input instanceof HTMLInputElement ? Number(input.value) : input.value,
          ],
        ),
      );
    return { smoothing: algorithm('smoothing-policy'), pressure, rejection: algorithm('rejection-policy') };
  }
  update(disabled: boolean) {
    this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('select, input').forEach((s) => {
      s.disabled = disabled;
    });
  }
}

export class PaintControls {
  private current: 'pen' | 'highlighter' = 'pen';
  private paints = { pen: { color: '#203b42', width: 3 }, highlighter: { color: '#f3d44e', width: 24 } };
  private color: HTMLInputElement;
  private width: HTMLInputElement;
  private palette: ColorPalette;
  constructor(color: HTMLInputElement, width: HTMLInputElement, palette: HTMLElement) {
    this.color = color;
    this.width = width;
    this.palette = new ColorPalette(palette, (value) => {
      color.value = value;
      this.update(color.disabled);
    });
    color.addEventListener('input', () => this.update(color.disabled));
  }
  update(disabled: boolean) {
    this.palette.update(this.color.value, disabled);
  }
  select(tool: Tool) {
    if ((tool !== 'pen' && tool !== 'highlighter') || tool === this.current) return;
    this.paints[this.current] = { color: this.color.value, width: Number(this.width.value) };
    this.current = tool;
    this.color.value = this.paints[tool].color;
    this.width.value = String(this.paints[tool].width);
  }
  style(tool: Tool): Style {
    return {
      color: this.color.value,
      lineWidth: Number(this.width.value),
      opacity: tool === 'highlighter' ? 0.28 : 1,
      blendMode: 'source-over',
    };
  }
}
