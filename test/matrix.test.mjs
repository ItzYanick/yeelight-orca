import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_FPS } from '../src/matrix-driver.mjs';
import { DEFAULT_SCENES, idleHearts } from '../src/scene.mjs';
import {
  HEART_MOTION,
  HEART_ORIGINS,
  HEART_SPRITE,
  MATRIX_COLS,
  MATRIX_LEDS,
  MATRIX_MAX_LEDS,
  MATRIX_ROWS,
  SPRITE_SIZE,
  blankPayload,
  distanceFromOrigin,
  encodeFrame,
  hexToRgb,
  heartPixel,
  indexFor,
  renderHeartsFrame,
  renderHeartsPayload,
  rippleAt
} from '../src/matrix.mjs';

/** The three bytes of one LED. */
function ledAt(frame, index) {
  return [frame[index * 3], frame[index * 3 + 1], frame[index * 3 + 2]];
}

/** Every LED index belonging to one heart's five columns. */
function heartIndices(heart) {
  const origin = HEART_ORIGINS[heart];
  const indices = [];
  for (let y = 0; y < MATRIX_ROWS; y += 1) {
    for (let x = origin; x < origin + SPRITE_SIZE; x += 1) {
      indices.push(indexFor(x, y));
    }
  }
  return indices;
}

const hearts = (...states) => states.map((state, index) => ({ index, state }));

describe('matrix geometry', () => {
  it('maps the bottom-left pixel to index 0, because row 0 is the bottom', () => {
    assert.equal(indexFor(0, MATRIX_ROWS - 1), 0);
  });

  it('maps the top-left pixel to the last row of indices', () => {
    assert.equal(indexFor(0, 0), (MATRIX_ROWS - 1) * MATRIX_COLS);
  });

  it('advances one index per column and twenty per row', () => {
    assert.equal(indexFor(1, MATRIX_ROWS - 1) - indexFor(0, MATRIX_ROWS - 1), 1);
    assert.equal(indexFor(0, MATRIX_ROWS - 2) - indexFor(0, MATRIX_ROWS - 1), MATRIX_COLS);
  });

  it('rejects anything off the panel', () => {
    for (const [x, y] of [[-1, 0], [MATRIX_COLS, 0], [0, -1], [0, MATRIX_ROWS]]) {
      assert.equal(indexFor(x, y), -1, `(${x},${y}) should be off-panel`);
    }
  });

  it('gives every LED a distinct index', () => {
    const seen = new Set();
    for (let y = 0; y < MATRIX_ROWS; y += 1) {
      for (let x = 0; x < MATRIX_COLS; x += 1) seen.add(indexFor(x, y));
    }
    assert.equal(seen.size, MATRIX_LEDS);
  });

  it('leaves room for three hearts without overlap', () => {
    for (let heart = 1; heart < HEART_ORIGINS.length; heart += 1) {
      assert.ok(
        HEART_ORIGINS[heart] >= HEART_ORIGINS[heart - 1] + SPRITE_SIZE,
        'hearts must not share a column'
      );
    }
    assert.ok(HEART_ORIGINS.at(-1) + SPRITE_SIZE <= MATRIX_COLS, 'the last heart must fit');
  });
});

describe('ripple', () => {
  const motion = HEART_MOTION.working;

  it('stays between its floor and full brightness', () => {
    for (let t = 0; t < 4000; t += 37) {
      for (let y = 0; y < SPRITE_SIZE; y += 1) {
        for (let x = 0; x < SPRITE_SIZE; x += 1) {
          const value = rippleAt(t, x, y, motion);
          assert.ok(value >= motion.floor - 1e-9, `dipped below the floor at ${x},${y},${t}`);
          assert.ok(value <= 1 + 1e-9, `exceeded full brightness at ${x},${y},${t}`);
        }
      }
    }
  });

  it('travels outward: the further out, the later the crest', () => {
    // Time of the first peak at increasing distance from the origin.
    const peakTime = (x, y) => {
      let best = 0;
      let bestValue = -Infinity;
      for (let t = 0; t < motion.periodMs; t += 1) {
        const value = rippleAt(t, x, y, motion);
        if (value > bestValue) {
          bestValue = value;
          best = t;
        }
      }
      return best;
    };

    const centre = peakTime(2, 2);
    const middle = peakTime(3, 2);
    const edge = peakTime(4, 2);

    assert.ok(distanceFromOrigin(3, 2) < distanceFromOrigin(4, 2), 'test points must be ordered');
    assert.ok(middle > centre, 'the crest should reach the middle after the centre');
    assert.ok(edge > middle, 'and the edge after the middle');
  });

  it('repeats every period', () => {
    const first = rippleAt(250, 1, 3, motion);
    const later = rippleAt(250 + motion.periodMs, 1, 3, motion);
    assert.ok(Math.abs(first - later) < 1e-9);
  });

  it('pulses attention faster than working, and idle slowest of all', () => {
    assert.ok(HEART_MOTION.attention.periodMs < HEART_MOTION.working.periodMs);
    assert.ok(HEART_MOTION.idle.periodMs > HEART_MOTION.working.periodMs);
  });

  /**
   * The panel tops out near 8 fps, so smoothness is governed by how far a pixel
   * moves between frames rather than by the frame rate. Anything past ~6% of
   * the brightness range per frame was visibly stepping on real hardware.
   */
  it('never moves a pixel far enough between frames to look stepped', () => {
    for (const [state, motion] of Object.entries(HEART_MOTION)) {
      const framesPerCycle = (motion.periodMs / 1000) * DEFAULT_FPS;
      const amplitude = 1 - motion.floor;
      // Steepest point of a sine, per frame.
      const maxDelta = (amplitude * Math.PI) / framesPerCycle;
      assert.ok(
        maxDelta <= 0.06,
        `${state} changes ${(maxDelta * 100).toFixed(1)}% per frame at ${DEFAULT_FPS} fps; ` +
          'slow the period or raise the floor'
      );
      assert.ok(framesPerCycle >= 30, `${state} has only ${framesPerCycle} frames per cycle`);
    }
  });
});

describe('heartPixel', () => {
  it('takes its colour from the configured scene', () => {
    // At the ripple's crest the pixel is the scene colour at full strength.
    const [r, g, b] = heartPixel('working', 0, 2, 2, DEFAULT_SCENES);
    const [wr, wg, wb] = hexToRgb(DEFAULT_SCENES.working.color);
    // Blue-dominant in, blue-dominant out.
    assert.ok(b > r && b > g, 'working should stay blue');
    assert.ok(b <= wb, 'never brighter than the scene colour itself');
    void wr;
    void wg;
  });

  it('follows a user palette', () => {
    const scenes = { ...DEFAULT_SCENES, working: { ...DEFAULT_SCENES.working, color: '#00ff00' } };
    let sawGreen = false;
    for (let t = 0; t < HEART_MOTION.working.periodMs; t += 50) {
      const [r, g, b] = heartPixel('working', t, 2, 2, scenes);
      if (g > 0) sawGreen = true;
      assert.equal(r, 0, 'a pure green scene must have no red');
      assert.equal(b, 0, 'a pure green scene must have no blue');
    }
    assert.ok(sawGreen);
  });

  it('rotates hue for an idle heart instead of pulsing one colour', () => {
    const early = heartPixel('idle', 0, 2, 2);
    const later = heartPixel('idle', 1200, 2, 2);
    assert.notDeepEqual(early, later, 'an idle heart should keep changing colour');
  });
});

describe('renderHeartsFrame', () => {
  it('produces exactly one frame of the panel', () => {
    const frame = renderHeartsFrame(idleHearts());
    assert.equal(frame.length, MATRIX_LEDS * 3);
  });

  it('lights only the sprite pixels, leaving the rest dark', () => {
    const frame = renderHeartsFrame(hearts('working', 'working', 'working'));

    for (let heart = 0; heart < HEART_ORIGINS.length; heart += 1) {
      const origin = HEART_ORIGINS[heart];
      for (let y = 0; y < SPRITE_SIZE; y += 1) {
        for (let x = 0; x < SPRITE_SIZE; x += 1) {
          const led = ledAt(frame, indexFor(origin + x, y));
          const lit = led.some((channel) => channel > 0);
          assert.equal(lit, Boolean(HEART_SPRITE[y][x]), `sprite mismatch at heart ${heart} ${x},${y}`);
        }
      }
    }
  });

  it('keeps each heart inside its own columns', () => {
    const frame = renderHeartsFrame(hearts('working', 'attention', 'idle'));
    const owned = new Set(HEART_ORIGINS.flatMap((_, heart) => heartIndices(heart)));

    for (let index = 0; index < MATRIX_LEDS; index += 1) {
      if (owned.has(index)) continue;
      assert.deepEqual(ledAt(frame, index), [0, 0, 0], `index ${index} is outside every heart`);
    }
  });

  it('never lets one heart disturb another', () => {
    const before = renderHeartsFrame(hearts('working', 'attention', 'idle'), { elapsedMs: 800 });
    const after = renderHeartsFrame(hearts('attention', 'attention', 'idle'), { elapsedMs: 800 });

    // Heart 0 changed state, so its pixels may differ...
    assert.notDeepEqual(
      heartIndices(0).map((index) => ledAt(before, index)),
      heartIndices(0).map((index) => ledAt(after, index))
    );
    // ...but hearts 1 and 2 must be byte-identical.
    for (const heart of [1, 2]) {
      assert.deepEqual(
        heartIndices(heart).map((index) => ledAt(before, index)),
        heartIndices(heart).map((index) => ledAt(after, index)),
        `heart ${heart} moved when heart 0 changed`
      );
    }
  });

  it('animates over time', () => {
    const a = renderHeartsFrame(hearts('working', 'attention', 'idle'), { elapsedMs: 0 });
    const b = renderHeartsFrame(hearts('working', 'attention', 'idle'), { elapsedMs: 400 });
    assert.notDeepEqual([...a], [...b]);
  });

  it('scales brightness without changing which pixels are lit', () => {
    const full = renderHeartsFrame(hearts('working', 'working', 'working'), { elapsedMs: 300 });
    const dim = renderHeartsFrame(hearts('working', 'working', 'working'), {
      elapsedMs: 300,
      brightnessScale: 0.25
    });

    let compared = 0;
    for (let index = 0; index < MATRIX_LEDS; index += 1) {
      const [fr, fg, fb] = ledAt(full, index);
      const [dr, dg, db] = ledAt(dim, index);
      assert.ok(dr <= fr && dg <= fg && db <= fb, `index ${index} got brighter when dimmed`);
      if (fr + fg + fb > 40) compared += 1;
    }
    assert.ok(compared > 0, 'the comparison needs some lit pixels');
  });

  it('treats a missing or short hearts list as idle', () => {
    assert.deepEqual([...renderHeartsFrame([])], [...renderHeartsFrame(idleHearts())]);
    assert.equal(renderHeartsFrame(undefined).length, MATRIX_LEDS * 3);
  });
});

describe('encodeFrame', () => {
  it('encodes three bytes per LED as base64', () => {
    const payload = renderHeartsPayload(idleHearts(), { elapsedMs: 0 });
    assert.equal(typeof payload, 'string');
    // 300 bytes -> 400 base64 characters, no padding needed.
    assert.equal(payload.length, (MATRIX_LEDS * 3 * 4) / 3);
    assert.match(payload, /^[A-Za-z0-9+/]+$/);
    assert.equal(Buffer.from(payload, 'base64').length, MATRIX_LEDS * 3);
  });

  it('round-trips the exact pixels', () => {
    const frame = renderHeartsFrame(hearts('working', 'attention', 'idle'), { elapsedMs: 700 });
    assert.deepEqual([...Buffer.from(encodeFrame(frame), 'base64')], [...frame]);
  });

  it('blanks to all zeroes', () => {
    assert.deepEqual([...Buffer.from(blankPayload(), 'base64')], new Array(MATRIX_LEDS * 3).fill(0));
  });

  it('refuses a frame the device would reject as memory exhausted', () => {
    assert.throws(() => encodeFrame(new Uint8Array((MATRIX_MAX_LEDS + 1) * 3)), /exceeds the device limit/);
  });

  it('refuses a partial LED', () => {
    assert.throws(() => encodeFrame(new Uint8Array(7)), /whole LEDs/);
  });
});
