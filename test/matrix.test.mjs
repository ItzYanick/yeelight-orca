import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_SCENES, idleHearts } from '../src/scene.mjs';
import {
  HEART_ORIGINS,
  HEART_SPRITE,
  MATRIX_COLS,
  MATRIX_LEDS,
  MATRIX_MAX_LEDS,
  MATRIX_ROWS,
  SPRITE_SIZE,
  blankPayload,
  encodeFrame,
  hexToRgb,
  heartPixel,
  indexFor,
  isLive,
  perceptualScale,
  renderHeartsFrame,
  renderHeartsPayload
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

/** The first lit column of the sprite's widest row, for sampling hues. */
const FIRST_LIT_COLUMN = HEART_SPRITE[1].indexOf(1);

const hearts = (...states) => states.map((state, index) => ({ index, state }));

/** Hue in degrees, for checking a sweep advances. */
function hueOf([r, g, b]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
}

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

describe('perceptualScale', () => {
  /**
   * Driving an LED at 42% looks like about 70% brightness, so anything meant to
   * read as a fraction has to be gamma-corrected or it comes out washed out.
   */
  it('darkens partial brightness so it looks like what it says', () => {
    assert.ok(perceptualScale(0.42) < 0.2);
    assert.ok(perceptualScale(0.7) < 0.7);
  });

  it('leaves full brightness alone and clamps the ends', () => {
    assert.equal(perceptualScale(1), 1);
    assert.equal(perceptualScale(0), 0);
    assert.equal(perceptualScale(2), 1);
    assert.equal(perceptualScale(-1), 0);
  });
});

describe('heartPixel', () => {
  it('knows which states are live', () => {
    assert.equal(isLive('working'), true);
    assert.equal(isLive('attention'), true);
    assert.equal(isLive('idle'), false);
    assert.equal(isLive(undefined), false);
  });

  it('paints a live heart in its scene colour', () => {
    const [r, g, b] = heartPixel('working', 2, 2, DEFAULT_SCENES);
    assert.ok(b > r && b > g, 'working is blue');

    const [ar, ag, ab] = heartPixel('attention', 2, 2, DEFAULT_SCENES);
    assert.ok(ar > ab && ag > ab, 'attention is orange, not blue');
  });

  it('follows a user palette', () => {
    const scenes = { ...DEFAULT_SCENES, working: { ...DEFAULT_SCENES.working, color: '#00ff00' } };
    const [r, g, b] = heartPixel('working', 2, 2, scenes);
    assert.equal(r, 0, 'a pure green scene has no red');
    assert.equal(b, 0, 'a pure green scene has no blue');
    assert.ok(g > 0);
  });

  it('honours the scene brightness', () => {
    const bright = { ...DEFAULT_SCENES, working: { ...DEFAULT_SCENES.working, brightness: 100 } };
    const dim = { ...DEFAULT_SCENES, working: { ...DEFAULT_SCENES.working, brightness: 30 } };
    const [, , brightBlue] = heartPixel('working', 2, 2, bright);
    const [, , dimBlue] = heartPixel('working', 2, 2, dim);
    assert.ok(dimBlue < brightBlue, 'a dimmer scene must produce a dimmer heart');
    assert.equal(brightBlue, hexToRgb(DEFAULT_SCENES.working.color)[2]);
  });

  it('sweeps hue across an idle heart', () => {
    const span = { start: 0, width: SPRITE_SIZE };
    const left = heartPixel('idle', 0, 2, DEFAULT_SCENES, { ...span, globalX: 0 });
    const right = heartPixel('idle', 4, 2, DEFAULT_SCENES, { ...span, globalX: 4 });
    assert.notDeepEqual(left, right, 'a rainbow must change colour across the heart');
  });
});

describe('renderHeartsFrame', () => {
  it('produces exactly one frame of the panel', () => {
    assert.equal(renderHeartsFrame(idleHearts()).length, MATRIX_LEDS * 3);
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
    const before = renderHeartsFrame(hearts('working', 'attention', 'idle'));
    const after = renderHeartsFrame(hearts('attention', 'attention', 'idle'));

    assert.notDeepEqual(
      heartIndices(0).map((index) => ledAt(before, index)),
      heartIndices(0).map((index) => ledAt(after, index)),
      'the heart that changed must change'
    );
    for (const heart of [1, 2]) {
      assert.deepEqual(
        heartIndices(heart).map((index) => ledAt(before, index)),
        heartIndices(heart).map((index) => ledAt(after, index)),
        `heart ${heart} moved when heart 0 changed`
      );
    }
  });

  /**
   * The panel is a still image. Nothing animates, so the same hearts must
   * always produce byte-identical frames — which is what lets the driver drop
   * duplicates and send almost nothing.
   */
  it('is completely static for a given set of hearts', () => {
    for (const set of [idleHearts(), hearts('working', 'attention', 'idle')]) {
      assert.deepEqual([...renderHeartsFrame(set)], [...renderHeartsFrame(set)]);
    }
  });

  it('spans a single rainbow across all three hearts when everything is idle', () => {
    const frame = renderHeartsFrame(idleHearts());
    const starts = HEART_ORIGINS.map((origin) => ledAt(frame, indexFor(origin + FIRST_LIT_COLUMN, 1)));

    assert.notDeepEqual(starts[0], starts[1], 'each heart must start on its own hue');
    assert.notDeepEqual(starts[1], starts[2], 'each heart must start on its own hue');

    const hues = starts.map(hueOf);
    assert.ok(hues[1] > hues[0], 'hue should advance from the first heart to the second');
    assert.ok(hues[2] > hues[1], 'and again to the third');
  });

  it('gives each idle heart its own rainbow while another is live', () => {
    const mixed = renderHeartsFrame(hearts('working', 'idle', 'idle'));
    const second = ledAt(mixed, indexFor(HEART_ORIGINS[1] + FIRST_LIT_COLUMN, 1));
    const third = ledAt(mixed, indexFor(HEART_ORIGINS[2] + FIRST_LIT_COLUMN, 1));
    assert.deepEqual(second, third, 'each idle heart sweeps its own five columns');

    const allIdle = renderHeartsFrame(idleHearts());
    const spanned = ledAt(allIdle, indexFor(HEART_ORIGINS[1] + FIRST_LIT_COLUMN, 1));
    assert.notDeepEqual(second, spanned, 'the spanning arrangement must differ');
  });

  it('scales brightness without changing which pixels are lit', () => {
    const full = renderHeartsFrame(hearts('working', 'working', 'working'));
    const dim = renderHeartsFrame(hearts('working', 'working', 'working'), { brightnessScale: 0.25 });

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
    const payload = renderHeartsPayload(idleHearts());
    assert.equal(payload.length, (MATRIX_LEDS * 3 * 4) / 3);
    assert.match(payload, /^[A-Za-z0-9+/]+$/);
    assert.equal(Buffer.from(payload, 'base64').length, MATRIX_LEDS * 3);
  });

  it('round-trips the exact pixels', () => {
    const frame = renderHeartsFrame(hearts('working', 'attention', 'idle'));
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
