import { ToolPicker, type PageTool } from './tool-picker.ts';

export type ToolbarSection =
  'tools' | 'history' | 'color' | 'thickness' | 'pages' | 'notes' | 'advanced' | 'zoom';
export type ToolbarLabels = 'auto' | 'icons' | 'labels';
/** Presentation only: omitted tools/sections move to Menu, preserving commands. */
export interface ToolbarConfig {
  tools: readonly PageTool[];
  sections: readonly ToolbarSection[];
  labels?: ToolbarLabels;
}
export const fullToolbar: ToolbarConfig = {
  tools: ['text', 'pen', 'highlighter', 'restyle', 'erase-parts', 'erase-strokes', 'lasso', 'pan'],
  sections: ['tools', 'history', 'color', 'thickness', 'pages', 'notes', 'advanced', 'zoom'],
};
export const minimalToolbar: ToolbarConfig = {
  tools: ['text', 'pen', 'highlighter', 'erase-parts', 'erase-strokes', 'lasso'],
  sections: ['tools', 'history', 'color', 'thickness'],
};
const presets = { full: fullToolbar, minimal: minimalToolbar };
const preferenceKey = 'event-draw-toolbar';

/** Move existing controls, rather than duplicating controls or their state. */
export class DrawingToolbar {
  private sections = new Map<ToolbarSection, HTMLElement>();
  private events = new AbortController();
  constructor(
    private root: HTMLElement,
    private overflow: HTMLElement,
    private tools: ToolPicker,
    picker: HTMLSelectElement,
    labels: HTMLSelectElement,
    custom?: ToolbarConfig,
  ) {
    for (const section of root.querySelectorAll<HTMLElement>('[data-toolbar-section]'))
      this.sections.set(section.dataset.toolbarSection as ToolbarSection, section);
    let preset: keyof typeof presets = 'full';
    let labelMode: ToolbarLabels = 'auto';
    try {
      const saved = JSON.parse(localStorage.getItem(preferenceKey) ?? 'null');
      if (saved?.preset === 'minimal') preset = 'minimal';
      if (['auto', 'icons', 'labels'].includes(saved?.labels)) labelMode = saved.labels;
    } catch {
      /* A view preference is optional when browser storage is unavailable. */
    }
    if (custom) {
      picker.add(new Option('Custom', 'custom'));
      picker.value = 'custom';
      labels.value = custom.labels ?? 'auto';
    } else {
      picker.value = preset;
      labels.value = labelMode;
    }
    const apply = () => {
      const config = picker.value === 'custom' ? custom! : presets[picker.value as keyof typeof presets];
      this.configure({ ...config, labels: labels.value as ToolbarLabels });
      if (picker.value !== 'custom') {
        try {
          localStorage.setItem(preferenceKey, JSON.stringify({ preset: picker.value, labels: labels.value }));
        } catch {
          /* Keep the controls usable without saving preferences. */
        }
      }
    };
    picker.addEventListener('change', apply, { signal: this.events.signal });
    labels.addEventListener('change', apply, { signal: this.events.signal });
    apply();
  }
  configure(config: ToolbarConfig) {
    if (
      new Set(config.sections).size !== config.sections.length ||
      config.sections.some((s) => !this.sections.has(s))
    )
      throw new Error('Toolbar sections must be unique known section IDs');
    if (config.labels && !['auto', 'icons', 'labels'].includes(config.labels))
      throw new Error('Unknown toolbar label mode');
    this.tools.configure(config.tools);
    this.root.dataset.labels = config.labels ?? 'auto';
    for (const id of config.sections) this.root.append(this.sections.get(id)!);
    for (const [id, section] of this.sections) {
      if (config.sections.includes(id)) continue;
      if (section instanceof HTMLDetailsElement) section.open = false;
      this.overflow.append(section);
    }
    this.overflow.hidden = config.sections.length === this.sections.size;
  }
  close() {
    this.events.abort();
  }
}
