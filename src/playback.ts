export interface PlaybackState {
  mode: 'stopped' | 'playing' | 'paused' | 'ended';
  elapsed: number;
  duration: number;
  speed: number;
}
export interface PlaybackClock {
  now(): number;
  request(callback: () => void): number;
  cancel(id: number): void;
}
/** Clock and UI are injected: the same controller can drive any trace viewer. */
export class Playback {
  private frame: number | undefined;
  private last = 0;
  readonly state: PlaybackState;
  private clock: PlaybackClock;
  private changed: (state: Readonly<PlaybackState>) => void;
  constructor(duration: number, clock: PlaybackClock, changed: (state: Readonly<PlaybackState>) => void) {
    this.clock = clock;
    this.changed = changed;
    this.state = { mode: 'stopped', elapsed: 0, duration: Math.max(0, duration), speed: 1 };
  }
  private advance() {
    const now = this.clock.now();
    this.state.elapsed = Math.min(
      this.state.duration,
      this.state.elapsed + Math.max(0, now - this.last) * this.state.speed,
    );
    this.last = now;
    if (this.state.elapsed >= this.state.duration) this.state.mode = 'ended';
  }
  private tick = () => {
    this.frame = undefined;
    this.advance();
    this.changed(this.state);
    if (this.state.mode === 'playing') this.frame = this.clock.request(this.tick);
  };
  play() {
    if (this.state.mode === 'playing') return;
    if (this.state.mode !== 'paused') this.state.elapsed = 0;
    this.state.mode = 'playing';
    this.last = this.clock.now();
    this.tick();
  }
  pause() {
    if (this.state.mode !== 'playing') return;
    this.close();
    this.advance();
    if (this.state.mode === 'playing') this.state.mode = 'paused';
    this.changed(this.state);
  }
  setSpeed(speed: number) {
    if (!Number.isFinite(speed) || speed <= 0) throw new Error('Playback speed must be positive');
    if (this.state.mode === 'playing') this.advance();
    this.state.speed = speed;
    this.changed(this.state);
  }
  stop() {
    this.close();
    this.state.mode = 'stopped';
    this.state.elapsed = 0;
    this.changed(this.state);
  }
  close() {
    if (this.frame !== undefined) this.clock.cancel(this.frame);
    this.frame = undefined;
  }
}
