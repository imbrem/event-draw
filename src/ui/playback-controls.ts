import { Playback, type PlaybackState } from '../playback.ts';

/** Embeddable presentation; elapsed time is shared by all comparison views. */
export class PlaybackControls {
  readonly playback: Playback;
  constructor(
    root: HTMLElement,
    duration: number,
    enabled: boolean,
    draw: (state: Readonly<PlaybackState>) => void,
  ) {
    root.classList.add('replay-controls');
    root.setAttribute('aria-label', 'Stroke playback');
    const button = (label: string, path: string, action: () => void) => {
      const node = document.createElement('button');
      node.setAttribute('aria-label', label);
      node.title = label;
      node.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">${path}</svg>`;
      node.onclick = action;
      root.append(node);
      return node;
    };
    const play = button('Play replay', '<path d="m7 4 14 8-14 8Z"/>', () => this.playback.play());
    const pause = button('Pause replay', '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>', () =>
      this.playback.pause(),
    );
    const stop = button('Stop replay', '<path d="M5 5h14v14H5z"/>', () => this.playback.stop());
    const label = document.createElement('label'),
      speed = document.createElement('input'),
      value = document.createElement('output');
    label.className = 'replay-speed';
    label.append('Speed ', speed, value);
    speed.type = 'range';
    speed.min = '0.25';
    speed.max = '4';
    speed.step = '0.25';
    speed.value = '1';
    speed.setAttribute('aria-label', 'Replay speed');
    speed.oninput = () => this.playback.setSpeed(Number(speed.value));
    const status = document.createElement('span');
    status.className = 'replay-status';
    // Do not announce each animation frame to screen readers.
    root.append(label, status);
    this.playback = new Playback(
      duration,
      {
        now: () => performance.now(),
        request: (callback) => requestAnimationFrame(callback),
        cancel: (id) => cancelAnimationFrame(id),
      },
      (state) => {
        play.disabled = !enabled || state.mode === 'playing';
        pause.disabled = state.mode !== 'playing';
        stop.disabled = state.mode === 'stopped';
        value.value = state.speed + '×';
        speed.setAttribute('aria-valuetext', state.speed + ' times');
        status.textContent =
          state.mode === 'stopped'
            ? 'Full capture'
            : state.mode === 'ended'
              ? 'Replay complete'
              : (state.mode === 'paused' ? 'Paused' : 'Replaying') +
                ' · ' +
                state.elapsed.toFixed(0) +
                ' / ' +
                duration.toFixed(0) +
                ' ms';
        draw(state);
      },
    );
    this.playback.stop();
  }
  close() {
    this.playback.close();
  }
}
