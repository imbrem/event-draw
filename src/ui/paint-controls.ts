import type { Tool, Style } from '../model.ts';
import { ColorPalette } from './color-palette.ts';

/** Remember independent pen/highlighter paints; policy and layout live elsewhere. */
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
