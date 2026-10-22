interface Actions {
  text(): void;
  escape(): void;
  undo(): void;
  redo(): void;
  copy(): void;
  paste(): void;
  duplicate(): void;
  remove(): void;
  previous(): void;
  next(): void;
  save(): void;
  selectAll(): void;
}
/** Native text editing keeps its keyboard behavior when an input owns focus. */
export function keyboardShortcuts(actions: Actions, enabled: () => boolean) {
  const keydown = (event: KeyboardEvent) => {
    if (
      !enabled() ||
      event.defaultPrevented ||
      event.isComposing ||
      (event.target instanceof Element &&
        event.target.closest('input,textarea,select,[contenteditable=true]'))
    )
      return;
    const command = event.metaKey || event.ctrlKey,
      key = event.key.toLowerCase();
    let action: (() => void) | undefined;
    if (command)
      action =
        key === 'z'
          ? event.shiftKey
            ? actions.redo
            : actions.undo
          : key === 'y'
            ? actions.redo
            : key === 'c'
              ? actions.copy
              : key === 'v'
                ? actions.paste
                : key === 'd'
                  ? actions.duplicate
                  : key === 's'
                    ? actions.save
                    : key === 'a'
                      ? actions.selectAll
                      : undefined;
    else if (!event.altKey)
      action =
        key === 't'
          ? actions.text
          : key === 'escape'
            ? actions.escape
            : key === 'delete' || key === 'backspace'
              ? actions.remove
              : key === 'pageup'
                ? actions.previous
                : key === 'pagedown'
                  ? actions.next
                  : undefined;
    if (action) {
      event.preventDefault();
      action();
    }
  };
  window.addEventListener('keydown', keydown);
  return () => window.removeEventListener('keydown', keydown);
}
