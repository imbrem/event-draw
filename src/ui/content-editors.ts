import { PluginRegistry } from '../plugins.ts';

export interface ContentEditor {
  element: HTMLElement;
  value: string;
  disabled: boolean;
  focus(): void;
  close(): void;
}
export interface ContentEditorOptions {
  label: string;
  input(source: string): void;
  done?(): void;
}
export interface ContentEditorStyle {
  label: string;
  mount(root: HTMLElement, options: ContentEditorOptions): ContentEditor;
}
/** Trusted host factories; notebook data never supplies executable editor code. */
export const contentEditors = new PluginRegistry<ContentEditorStyle>();
for (const [id, label] of [
  ['writing', 'Writing'],
  ['source', 'Source code'],
]) {
  contentEditors.set(id, {
    label,
    mount(root, options) {
      const input = document.createElement('textarea');
      input.className = 'content-editor editor-' + id;
      input.setAttribute('aria-label', options.label);
      input.spellcheck = id === 'writing';
      input.placeholder = 'Type here…';
      input.maxLength = 200000;
      input.oninput = () => options.input(input.value);
      input.onkeydown = (event) => {
        if (
          !event.isComposing &&
          (event.key === 'Escape' || ((event.metaKey || event.ctrlKey) && event.key === 'Enter'))
        ) {
          event.preventDefault();
          event.stopPropagation();
          options.done?.();
        }
      };
      root.append(input);
      return {
        element: input,
        get value() {
          return input.value;
        },
        set value(value) {
          if (input.value !== value) input.value = value;
        },
        get disabled() {
          return input.disabled;
        },
        set disabled(value) {
          input.disabled = value;
        },
        focus: () => input.focus(),
        close: () => input.remove(),
      };
    },
  });
}
