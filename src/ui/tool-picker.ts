import type { Tool } from '../model.ts';

const TOOLS: { id: Tool; label: string; name: string; description: string; icon: string }[] = [
  { id: 'pen', label: 'Pen', name: 'Pen', description: 'Draw ink',
    icon: '<path d="m4 16-1 5 5-1L20 8a2.1 2.1 0 0 0-4-4L4 16Zm10-10 4 4M4 16l4 4"/>' },
  { id: 'erase-parts', label: 'Erase parts', name: 'Erase parts', description: 'Cut away only the ink you touch',
    icon: '<path d="m4 13 8-9a2 2 0 0 1 3 0l5 5a2 2 0 0 1 0 3l-8 9H8l-4-4a3 3 0 0 1 0-4Zm4-4 9 9M16 21h5"/>' },
  { id: 'erase-strokes', label: 'Erase strokes', name: 'Erase whole strokes', description: 'Delete each whole shape you touch',
    icon: '<path d="M3 5h7M3 10h3M3 21h18m-14-8 7-8a2 2 0 0 1 3 0l4 4a2 2 0 0 1 0 3l-7 8h-4l-3-3a3 3 0 0 1 0-4Zm3-3 8 8"/>' },
  { id: 'lasso', label: 'Lasso', name: 'Lasso select', description: 'Loop around ink to select; drag the selection to move',
    icon: '<path d="M7 17C1 15 2 5 12 4c11-1 12 11 3 13-7 2-11-1-8-3 2-1 4 1 3 4l-2 4" stroke-dasharray="3 2"/>' },
  { id: 'pan', label: 'Pan', name: 'Pan board', description: 'Drag to explore an infinite whiteboard',
    icon: '<path d="M8 13V6a2 2 0 0 1 4 0v6-8a2 2 0 0 1 4 0v8-5a2 2 0 0 1 4 0v8c0 4-2 7-6 7h-1c-3 0-4-1-6-4l-4-5a2 2 0 0 1 3-3l2 3Z"/>' },
];

/** Owns tool presentation and availability; drawing code only consumes Tool. */
export class ToolPicker {
  private current: Tool = 'pen';
  private buttons = new Map<Tool, HTMLButtonElement>();
  private availability = { disabled: true, whiteboard: false };

  constructor(root: HTMLElement, onChange: () => void) {
    for (const tool of TOOLS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.tool = tool.id;
      button.setAttribute('aria-label', tool.name);
      button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" ' +
        'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + tool.icon +
        '</svg><span>' + tool.label + '</span>';
      button.onclick = () => {
        if (button.disabled || this.current === tool.id) return;
        this.current = tool.id;
        this.render();
        onChange();
      };
      this.buttons.set(tool.id, button);
      root.append(button);
    }
    this.render();
  }

  get value(): Tool { return this.current; }

  update(availability: { disabled: boolean; whiteboard: boolean }) {
    this.availability = availability;
    if (!availability.whiteboard && this.current === 'pan') this.current = 'pen';
    this.render();
  }

  private render() {
    const { disabled, whiteboard } = this.availability;
    for (const tool of TOOLS) {
      const button = this.buttons.get(tool.id)!;
      button.disabled = disabled || (tool.id === 'pan' && !whiteboard);
      button.setAttribute('aria-pressed', String(this.current === tool.id));
      button.title = tool.id === 'pan' && !whiteboard ? 'Pan is available on infinite whiteboards' : tool.description;
    }
  }
}
