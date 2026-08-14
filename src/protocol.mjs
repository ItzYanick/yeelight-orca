/**
 * Yeelight LAN Control protocol primitives — pure functions, no I/O.
 *
 * Everything here is derived from the "Yeelight WiFi Light Inter-Operation
 * Specification": SSDP-style discovery on UDP 239.255.255.250:1982 and a
 * newline-delimited JSON-RPC dialect on TCP 55443.
 *
 * Kept I/O-free so the scene mapping and wire encoding are testable without a
 * bulb on the network.
 */

export const YEELIGHT_MULTICAST_ADDR = '239.255.255.250';
export const YEELIGHT_MULTICAST_PORT = 1982;
export const YEELIGHT_CONTROL_PORT = 55443;

/** Devices silently drop connections that exceed ~60 commands/minute. */
export const YEELIGHT_RATE_LIMIT_PER_MINUTE = 60;

/** Discovery probe. The trailing blank line terminates the SSDP request. */
export const DISCOVERY_MESSAGE = Buffer.from(
  [
    'M-SEARCH * HTTP/1.1',
    `HOST: ${YEELIGHT_MULTICAST_ADDR}:${YEELIGHT_MULTICAST_PORT}`,
    'MAN: "ssdp:discover"',
    'ST: wifi_bulb',
    ''
  ].join('\r\n')
);

/**
 * Parses an SSDP discovery response (or an unsolicited NOTIFY advertisement)
 * into a device record. Returns null for anything that is not a Yeelight.
 */
export function parseDiscoveryResponse(text, fallbackAddress) {
  const lines = String(text).split(/\r?\n/);
  const statusLine = lines[0] ?? '';
  // Both `HTTP/1.1 200 OK` (search reply) and `NOTIFY * HTTP/1.1` (advert).
  if (!/^(HTTP\/1\.1 200 OK|NOTIFY \* HTTP\/1\.1)/i.test(statusLine.trim())) {
    return null;
  }

  const headers = {};
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }

  const location = headers.location ?? '';
  const match = /^yeelight:\/\/(\[[^\]]+\]|[^:]+):(\d+)$/.exec(location);
  if (!match && !fallbackAddress) return null;

  const host = match ? match[1] : fallbackAddress;
  const port = match ? Number.parseInt(match[2], 10) : YEELIGHT_CONTROL_PORT;
  const id = headers.id || `${host}:${port}`;

  return {
    id,
    host,
    port: Number.isFinite(port) && port > 0 ? port : YEELIGHT_CONTROL_PORT,
    model: headers.model || 'unknown',
    name: headers.name || '',
    firmware: headers.fw_ver || '',
    // `support` lists the methods this model implements; we feature-detect
    // against it instead of hardcoding a per-model capability table.
    support: (headers.support || '').split(/\s+/).filter(Boolean),
    power: headers.power === 'on' ? 'on' : headers.power === 'off' ? 'off' : null
  };
}

/** Encodes one JSON-RPC command. The device requires a trailing CRLF. */
export function encodeCommand(id, method, params) {
  return `${JSON.stringify({ id, method, params })}\r\n`;
}

/**
 * Splits a TCP read buffer into complete newline-delimited JSON messages.
 * Returns the parsed messages plus whatever partial tail must be carried into
 * the next read.
 */
export function decodeMessages(buffered) {
  const messages = [];
  let rest = buffered;

  for (;;) {
    const newline = rest.indexOf('\n');
    if (newline < 0) break;
    const line = rest.slice(0, newline).trim();
    rest = rest.slice(newline + 1);
    if (!line) continue;
    try {
      messages.push(JSON.parse(line));
    } catch {
      // A malformed line is not worth tearing the connection down for.
    }
  }

  return { messages, rest };
}

/** Clamps to the 1-100 range the device accepts for brightness. */
export function clampBrightness(value) {
  if (!Number.isFinite(value)) return 100;
  return Math.min(100, Math.max(1, Math.round(value)));
}

/** Packs an `#rrggbb` string or `[r,g,b]` triple into the integer the API wants. */
export function toRgbInt(color) {
  if (Array.isArray(color)) {
    const [r, g, b] = color;
    return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
  }
  if (typeof color === 'number') return color & 0xffffff;

  const hex = String(color).trim().replace(/^#/, '');
  const expanded =
    hex.length === 3
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex;
  const parsed = Number.parseInt(expanded, 16);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid color: ${color}`);
  }
  // Yeelight rejects rgb value 0 (it means "unset"), so nudge pure black.
  return (parsed & 0xffffff) || 1;
}

export function toHexColor(rgbInt) {
  return `#${(rgbInt & 0xffffff).toString(16).padStart(6, '0')}`;
}

/** HSV -> hex. Used to synthesise palettes (the rainbow effect) from a hue. */
export function hsvToHex(hue, saturation = 1, value = 1) {
  const h = ((hue % 360) + 360) % 360;
  const s = Math.min(1, Math.max(0, saturation));
  const v = Math.min(1, Math.max(0, value));

  const chroma = v * s;
  const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - chroma;
  const sector = Math.floor(h / 60) % 6;

  const [r, g, b] = [
    [chroma, x, 0],
    [x, chroma, 0],
    [0, chroma, x],
    [0, x, chroma],
    [x, 0, chroma],
    [chroma, 0, x]
  ][sector];

  const channel = (component) =>
    Math.round((component + m) * 255)
      .toString(16)
      .padStart(2, '0');

  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/**
 * Evenly spaced hues around the wheel.
 *
 * `offsetDeg` rotates the starting hue. That is what lets several lights run
 * the same sweep a fraction of a turn apart, so they read as one rainbow
 * spanning the room rather than three synchronised copies of the same one.
 */
export function rainbowPalette(count = 6, offsetDeg = 0) {
  const size = Math.min(8, Math.max(2, Math.round(count)));
  const offset = Number.isFinite(offsetDeg) ? offsetDeg : 0;
  return Array.from({ length: size }, (_, index) => hsvToHex(offset + (index * 360) / size));
}

/**
 * Builds a color-flow expression: a comma-separated list of
 * `duration, mode, value, brightness` tuples.
 *
 * mode 1 = RGB colour, 2 = colour temperature, 7 = sleep.
 */
export function buildFlowExpression(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('a color flow needs at least one step');
  }
  return steps
    .map((step) => {
      // The device's own minimum transition is 50ms; shorter values error out.
      const duration = Math.max(50, Math.round(step.duration ?? 500));
      const mode = step.mode ?? 1;
      const value = mode === 1 ? toRgbInt(step.color ?? '#ffffff') : Math.round(step.value ?? 4000);
      const brightness = mode === 7 ? -1 : clampBrightness(step.brightness ?? 100);
      return `${duration},${mode},${value},${brightness}`;
    })
    .join(',');
}

/**
 * Lowers a resolved scene to the smallest command sequence that realises it.
 *
 * One command per change matters: it keeps a burst of agent-status events well
 * inside the device's per-minute budget. `set_scene` is preferred because it
 * powers the light on and applies colour + brightness atomically; models that
 * do not advertise it fall back to the discrete calls.
 */
export function sceneToCommands(scene, { support = [], transitionMs = 400 } = {}) {
  const supports = (method) => support.length === 0 || support.includes(method);
  const duration = Math.max(30, Math.round(transitionMs));

  if (scene.power === 'off') {
    return [{ method: 'set_power', params: ['off', 'smooth', duration] }];
  }

  if (scene.flow) {
    const expression = buildFlowExpression(scene.flow.steps);
    // action 0 = revert to the pre-flow state when the flow ends.
    const count = scene.flow.count ?? 0;
    const action = scene.flow.action ?? 0;

    if (supports('set_scene')) {
      return [{ method: 'set_scene', params: ['cf', count, action, expression] }];
    }
    return [
      { method: 'set_power', params: ['on', 'smooth', duration] },
      { method: 'start_cf', params: [count, action, expression] }
    ];
  }

  const rgb = toRgbInt(scene.color);
  const brightness = clampBrightness(scene.brightness);

  if (supports('set_scene')) {
    return [{ method: 'set_scene', params: ['color', rgb, brightness] }];
  }

  const commands = [{ method: 'set_power', params: ['on', 'smooth', duration] }];
  if (supports('stop_cf')) commands.push({ method: 'stop_cf', params: [] });
  commands.push({ method: 'set_rgb', params: [rgb, 'smooth', duration] });
  commands.push({ method: 'set_bright', params: [brightness, 'smooth', duration] });
  return commands;
}

/** Stable identity for a resolved scene, used to skip redundant writes. */
export function sceneFingerprint(scene) {
  if (!scene) return 'none';
  if (scene.power === 'off') return 'off';
  if (scene.flow) return `cf:${buildFlowExpression(scene.flow.steps)}:${scene.flow.count ?? 0}`;
  return `solid:${toRgbInt(scene.color)}:${clampBrightness(scene.brightness)}`;
}
