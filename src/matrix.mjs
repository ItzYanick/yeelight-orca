/**
 * Rendering for Yeelight matrix panels (Cube Lite).
 *
 * A panel is not a bulb: it has no colour-flow engine, so `activate_fx_mode
 * {"mode":"direct"}` — the only effect mode the LAN protocol exposes — means
 * "the host draws every frame".
 *
 * These hearts do not animate, and that is a hardware decision rather than a
 * stylistic one. Driving the panel continuously wedged two units: they stop
 * acknowledging commands and go dark until they are unplugged, and the second
 * one did it while being driven at one frame a second, comfortably inside every
 * budget that could be measured. A display you have to power cycle is worse
 * than a still one, so a heart is a flat colour and the frame changes only when
 * an agent's status does — a few commands a day rather than tens of thousands.
 *
 * Colour carries the whole message anyway: blue working, orange wants you,
 * rainbow idle.
 *
 * Geometry was established by lighting known indices and photographing the
 * result: 100 LEDs in a 20x5 grid, `index = row * 20 + col`, no serpentine —
 * and row 0 is the panel's BOTTOM edge, which is why `indexFor` flips.
 */

import { DEFAULT_SCENES, HEART_COUNT } from './scene.mjs';

export const MATRIX_COLS = 20;
export const MATRIX_ROWS = 5;
export const MATRIX_LEDS = MATRIX_COLS * MATRIX_ROWS;

/**
 * Frames of 175 LEDs or more come back as `error 5 memory exhausted`, so the
 * device's input buffer sits between 160 and 175 entries. Ours is well under,
 * but the ceiling is recorded here so a future larger panel fails loudly.
 */
export const MATRIX_MAX_LEDS = 160;

/** A heart is 5x5 — the panel's full height, and a shape that survives it. */
export const SPRITE_SIZE = 5;

/**
 * Row 0 of a sprite is its TOP row, which is how anyone reading the bitmap
 * below expects it to look. The panel numbers rows from the bottom, so this is
 * the single place that flip happens.
 */
export function indexFor(x, y) {
  if (x < 0 || x >= MATRIX_COLS || y < 0 || y >= MATRIX_ROWS) return -1;
  return (MATRIX_ROWS - 1 - y) * MATRIX_COLS + x;
}

/** The heart, drawn the right way up. */
export const HEART_SPRITE = [
  [0, 1, 0, 1, 0],
  [1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1],
  [0, 1, 1, 1, 0],
  [0, 0, 1, 0, 0]
];

/**
 * Three hearts across twenty columns: 5 + 5 + 5 of sprite and 5 of gap.
 * One column of margin at the left and two between hearts keeps them from
 * reading as one 15-wide blob.
 */
export const HEART_ORIGINS = [1, 8, 15];

/** How bright an idle heart's rainbow sits. */
export const IDLE_BRIGHTNESS = 0.9;

/**
 * Perceived brightness is not proportional to LED output.
 *
 * Halving a channel does not look half as bright — the eye follows roughly a
 * 2.2 power curve, so an LED driven at 40% reads as about 66%. Anything meant
 * to look like a fraction of full brightness has to be raised by gamma first,
 * or it comes out washed out and far brighter than intended.
 */
const GAMMA = 2.2;

/** A 0..1 brightness (as perceived) to a channel multiplier (as driven). */
export function perceptualScale(scale) {
  return Math.min(1, Math.max(0, scale)) ** GAMMA;
}

function clampChannel(value) {
  return Math.min(255, Math.max(0, Math.round(value)));
}

/** `#rrggbb` (or `#rgb`) to a channel triple. */
export function hexToRgb(hex) {
  const raw = String(hex).trim().replace(/^#/, '');
  const full =
    raw.length === 3
      ? raw
          .split('')
          .map((channel) => channel + channel)
          .join('')
      : raw;
  const value = Number.parseInt(full, 16);
  if (!Number.isFinite(value)) return [255, 255, 255];
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** HSV to a channel triple. Kept local so the panel path owns its own maths. */
export function hsvToRgb(hue, saturation = 1, value = 1) {
  const h = ((hue % 360) + 360) % 360;
  const s = Math.min(1, Math.max(0, saturation));
  const v = Math.min(1, Math.max(0, value));
  const chroma = v * s;
  const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - chroma;
  const [r, g, b] = [
    [chroma, x, 0],
    [x, chroma, 0],
    [0, chroma, x],
    [0, x, chroma],
    [x, 0, chroma],
    [chroma, 0, x]
  ][Math.floor(h / 60) % 6];
  return [clampChannel((r + m) * 255), clampChannel((g + m) * 255), clampChannel((b + m) * 255)];
}

/** A live heart is a flat colour; anything else is part of a rainbow. */
export function isLive(state) {
  return state === 'working' || state === 'attention';
}

/**
 * The colour of one lit sprite pixel.
 *
 * `rainbow` says which stretch of panel an idle heart's hue sweep is measured
 * across: its own five columns normally, or all three hearts at once when
 * nothing is running, so they read as a single rainbow laid over the set.
 */
export function heartPixel(state, x, y, scenes = DEFAULT_SCENES, rainbow = null) {
  if (!isLive(state)) {
    const { start = 0, width = SPRITE_SIZE, globalX = x } = rainbow ?? {};
    const position = width <= 0 ? 0 : (globalX - start) / width;
    return hsvToRgb(position * 360, 1, perceptualScale(IDLE_BRIGHTNESS));
  }

  const fallback = state === 'attention' ? DEFAULT_SCENES.waiting : DEFAULT_SCENES.working;
  const definition = (state === 'attention' ? scenes?.waiting : scenes?.working) ?? fallback;
  const [r, g, b] = hexToRgb(definition.color ?? fallback.color);
  // The scene's own brightness still applies, so a dimmed palette stays dimmed.
  const scale = perceptualScale((definition.brightness ?? 100) / 100);
  return [clampChannel(r * scale), clampChannel(g * scale), clampChannel(b * scale)];
}

/**
 * Composes the whole panel.
 *
 * Each heart draws only into its own five columns, so one heart can never
 * disturb another — the property that makes the display countable at a glance.
 */
export function renderHeartsFrame(hearts, { scenes = DEFAULT_SCENES, brightnessScale = 1 } = {}) {
  const scale = Number.isFinite(brightnessScale) ? Math.min(1, Math.max(0.05, brightnessScale)) : 1;
  const pixels = new Uint8Array(MATRIX_LEDS * 3);
  const count = Math.min(HEART_COUNT, HEART_ORIGINS.length);

  const stateOf = (heart) => hearts?.[heart]?.state ?? 'idle';

  // With nothing running the hue sweep spans the whole run of hearts instead of
  // restarting in each, so they read as one rainbow rather than three copies.
  const everythingIdle = Array.from({ length: count }, (_, heart) => stateOf(heart)).every(
    (state) => !isLive(state)
  );
  const spanStart = HEART_ORIGINS[0];
  const spanWidth = HEART_ORIGINS[count - 1] + SPRITE_SIZE - spanStart;

  for (let heart = 0; heart < count; heart += 1) {
    const state = stateOf(heart);
    const originX = HEART_ORIGINS[heart];

    for (let y = 0; y < SPRITE_SIZE; y += 1) {
      for (let x = 0; x < SPRITE_SIZE; x += 1) {
        if (!HEART_SPRITE[y][x]) continue;
        const globalX = originX + x;
        const index = indexFor(globalX, y);
        if (index < 0) continue;

        const rainbow = everythingIdle
          ? { start: spanStart, width: spanWidth, globalX }
          : { start: originX, width: SPRITE_SIZE, globalX };

        const [r, g, b] = heartPixel(state, x, y, scenes, rainbow);
        pixels[index * 3] = clampChannel(r * scale);
        pixels[index * 3 + 1] = clampChannel(g * scale);
        pixels[index * 3 + 2] = clampChannel(b * scale);
      }
    }
  }

  return pixels;
}

/**
 * Encodes a pixel buffer for `update_leds`.
 *
 * The device wants three bytes per LED, base64. Because 3 bytes is exactly one
 * base64 group, encoding each colour separately and concatenating produces the
 * identical string to encoding the whole buffer — this does the latter.
 */
export function encodeFrame(pixels) {
  if (pixels.length % 3 !== 0) {
    throw new Error(`frame must be whole LEDs; got ${pixels.length} bytes`);
  }
  const leds = pixels.length / 3;
  if (leds > MATRIX_MAX_LEDS) {
    throw new Error(`frame of ${leds} LEDs exceeds the device limit of ${MATRIX_MAX_LEDS}`);
  }
  return Buffer.from(pixels).toString('base64');
}

/** Convenience: hearts straight to the string the device wants. */
export function renderHeartsPayload(hearts, options) {
  return encodeFrame(renderHeartsFrame(hearts, options));
}

/** An all-black frame, for blanking the panel on shutdown. */
export function blankPayload() {
  return encodeFrame(new Uint8Array(MATRIX_LEDS * 3));
}
