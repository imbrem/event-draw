export interface ColorChoice {
  name: string;
  value: string;
}
export const COMMON_COLORS: readonly ColorChoice[] = [
  { name: 'Ink', value: '#203b42' },
  { name: 'Red', value: '#e03131' },
  { name: 'Orange', value: '#e67700' },
  { name: 'Yellow', value: '#f3d44e' },
  { name: 'Green', value: '#2f9e44' },
  { name: 'Blue', value: '#1971c2' },
  { name: 'Violet', value: '#7048e8' },
];
/** Presentation only: the paint controller owns the selected per-tool color. */
export class ColorPalette {
  private buttons = new Map<string, HTMLButtonElement>();
  constructor(root: HTMLElement, select: (value: string) => void, colors = COMMON_COLORS) {
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'Common ink colors');
    for (const color of colors) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'color-swatch';
      button.style.setProperty('--swatch', color.value);
      button.title = color.name;
      button.setAttribute('aria-label', color.name + ' ink');
      button.onclick = () => select(color.value);
      root.append(button);
      this.buttons.set(color.value, button);
    }
  }
  update(color: string, disabled: boolean) {
    for (const [value, button] of this.buttons) {
      button.disabled = disabled;
      button.setAttribute('aria-pressed', String(color.toLowerCase() === value));
    }
  }
}
