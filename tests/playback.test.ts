import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Playback } from '../src/playback.ts';

test('pause/resume and speed changes preserve replay position; stop and close cancel scheduling', () => {
  let now = 0,
    next = 0;
  const frames = new Map<number, () => void>();
  const player = new Playback(
    1000,
    {
      now: () => now,
      request: (fn) => {
        frames.set(++next, fn);
        return next;
      },
      cancel: (id) => {
        frames.delete(id);
      },
    },
    () => {},
  );
  const tick = (at: number) => {
    now = at;
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((fn) => fn());
  };
  player.play();
  tick(100);
  assert.equal(player.state.elapsed, 100);
  now = 150;
  player.pause();
  assert.equal(player.state.elapsed, 150);
  assert.equal(frames.size, 0);
  tick(500);
  assert.equal(player.state.elapsed, 150);
  player.play();
  tick(550);
  assert.equal(player.state.elapsed, 200);
  now = 600;
  player.setSpeed(2);
  assert.equal(player.state.elapsed, 250);
  tick(650);
  assert.equal(player.state.elapsed, 350);
  tick(1000);
  assert.equal(player.state.mode, 'ended');
  assert.equal(player.state.elapsed, 1000);
  assert.equal(frames.size, 0);
  player.play();
  assert.equal(player.state.elapsed, 0);
  player.stop();
  assert.equal(frames.size, 0);
  assert.equal(player.state.mode, 'stopped');
  player.play();
  player.close();
  assert.equal(frames.size, 0);
  assert.throws(() => player.setSpeed(0));
  assert.throws(() => player.setSpeed(NaN));
});
test('zero duration completes immediately, replay can restart', () => {
  const player = new Playback(
    0,
    {
      now: () => 0,
      request: () => {
        throw new Error('No frame needed');
      },
      cancel: () => {},
    },
    () => {},
  );
  player.play();
  assert.equal(player.state.mode, 'ended');
  player.play();
  assert.equal(player.state.mode, 'ended');
});
