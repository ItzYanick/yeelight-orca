/**
 * Rendering for Yeelight matrix panels (Cube Lite).
 *
 * A panel is not a bulb: it has no colour-flow engine, so nothing animates on
 * its own. `activate_fx_mode {"mode":"direct"}` is the only effect mode the LAN
 * protocol exposes, and it means "the host draws every frame". Everything here
 * is therefore a pure function from (hearts, time) to one encoded frame; the
 * pushing lives in `matrix-driver.mjs`.
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

/**
 * Where the ripple is born, in sprite coordinates.
 *
 * The geometric centre (2,2) rather than the lit pixels' centroid: the centroid
 * sits low, because the heart's point occupies rows the lobes do not, and a
 * ripple starting there reads as coming from the bottom tip instead of the
 * middle.
 */
export const RIPPLE_ORIGIN = { x: 2, y: 2 };

/**
 * Per-state motion. Colours come from the configured scenes; this does not.
 *
 * These periods look absurdly slow written down, and they are the result of
 * watching the real panel. The constraint is that a matrix can only be driven
 * at about 8 fps before the firmware's request quota starts refusing frames, so
 * smoothness is not set by the frame rate but by **how much a pixel changes
 * between consecutive frames**. A 2.4s ripple at 8 fps moves ~13% of the
 * brightness range per frame, which the eye reads as stepping, not motion.
 *
 * Both levers here shrink that delta: a longer period spreads the cycle over
 * more frames, and a higher floor (a shallower dip) reduces the range being
 * traversed. At these values the worst-case per-frame change is:
 *
 *   working    9000ms  72 frames/cycle   2.4%
 *   attention  5000ms  40 frames/cycle   5.3%
 *   idle      12000ms  96 frames/cycle   1.6%
 *
 * `attention` is deliberately the twitchiest of the three — it is the one state
 * meant to catch your eye, and its faster, deeper ripple is what distinguishes
 * it from `working` across the room.
 */
export const HEART_MOTION = {
  working: { periodMs: 9000, spread: 0.9, floor: 0.45 },
  attention: { periodMs: 5000, spread: 1.0, floor: 0.32 },
  idle: { periodMs: 12_000, spread: 0.7, floor: 0.5 }
};

/** Hue degrees swept per second by an idle heart's rainbow. */
const IDLE_HUE_DEGREES_PER_SECOND = 70;
/** Hue degrees added per pixel of distance, so the rainbow ripples outward. */
const IDLE_HUE_PER_PIXEL = 26;

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

/**
 * The ripple: a wave leaving the centre and travelling outward.
 *
 * Phase is `omega * t - spread * distance`, so a given phase value sits further
 * out as time advances — the crest moves away from the origin. Subtracting the
 * distance rather than adding it is the whole difference between a wave that
 * radiates and one that converges.
 *
 * Returns a 0..1 brightness scale, never reaching 0: a heart that blinks fully
 * out stops reading as a heart.
 */
export function rippleAt(elapsedMs, x, y, { periodMs, spread, floor }) {
  const dx = x - RIPPLE_ORIGIN.x;
  const dy = y - RIPPLE_ORIGIN.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  const phase = (elapsedMs / periodMs) * 2 * Math.PI - distance * spread;
  const swell = 0.5 + 0.5 * Math.sin(phase);
  return floor + (1 - floor) * swell;
}

/** Distance from the ripple origin, exposed for the hue offset and for tests. */
export function distanceFromOrigin(x, y) {
  const dx = x - RIPPLE_ORIGIN.x;
  const dy = y - RIPPLE_ORIGIN.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * The colour of one lit sprite pixel.
 *
 * Split out so a heart's appearance can be unit-tested a pixel at a time, and
 * so the idle rainbow's two motions — brightness rippling, hue rotating — stay
 * visibly distinct from the single motion of the other two states.
 */
export function heartPixel(state, elapsedMs, x, y, scenes = DEFAULT_SCENES) {
  const motion = HEART_MOTION[state] ?? HEART_MOTION.idle;
  const scale = rippleAt(elapsedMs, x, y, motion);

  if (state === 'idle') {
    const hue =
      (elapsedMs / 1000) * IDLE_HUE_DEGREES_PER_SECOND + distanceFromOrigin(x, y) * IDLE_HUE_PER_PIXEL;
    return hsvToRgb(hue, 1, scale);
  }

  const definition =
    state === 'attention'
      ? (scenes?.waiting ?? DEFAULT_SCENES.waiting)
      : (scenes?.working ?? DEFAULT_SCENES.working);
  const [r, g, b] = hexToRgb(definition.color ?? '#ffffff');
  return [clampChannel(r * scale), clampChannel(g * scale), clampChannel(b * scale)];
}

/**
 * Composes the whole panel for one instant.
 *
 * Each heart is drawn from its own state and its own origin, and writes only
 * into its own five columns — so one heart's animation can never disturb
 * another's, which is the property that makes the display countable at a
 * glance.
 */
export function renderHeartsFrame(hearts, { elapsedMs = 0, scenes = DEFAULT_SCENES, brightnessScale = 1 } = {}) {
  const scale = Number.isFinite(brightnessScale) ? Math.min(1, Math.max(0.05, brightnessScale)) : 1;
  const pixels = new Uint8Array(MATRIX_LEDS * 3);

  for (let heart = 0; heart < Math.min(HEART_COUNT, HEART_ORIGINS.length); heart += 1) {
    const state = hearts?.[heart]?.state ?? 'idle';
    const originX = HEART_ORIGINS[heart];

    for (let y = 0; y < SPRITE_SIZE; y += 1) {
      for (let x = 0; x < SPRITE_SIZE; x += 1) {
        if (!HEART_SPRITE[y][x]) continue;
        const index = indexFor(originX + x, y);
        if (index < 0) continue;
        const [r, g, b] = heartPixel(state, elapsedMs, x, y, scenes);
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

/** Convenience: hearts + time straight to the string the device wants. */
export function renderHeartsPayload(hearts, options) {
  return encodeFrame(renderHeartsFrame(hearts, options));
}

/** An all-black frame, for blanking the panel on shutdown. */
export function blankPayload() {
  return encodeFrame(new Uint8Array(MATRIX_LEDS * 3));
}
