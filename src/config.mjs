/**
 * User configuration.
 *
 * Orca's plugin panels are sandboxed with no network and a three-action bridge,
 * so a plugin cannot ship its own settings UI that writes back to the worker.
 * The configuration surface is therefore a plain JSON file in a stable place
 * the user already owns — `~/.orca/yeelight.json` — created with defaults and
 * commented documentation on first run, and hot-reloaded when it changes.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_SCENES, DEFAULT_TIMING, EFFECTS } from './scene.mjs';

/**
 * `ORCA_YEELIGHT_CONFIG` overrides the location — used by the tests and handy
 * for running the CLI against a second set of lights. Orca's plugin worker
 * runs with a fixed env allowlist, so inside Orca this is always the default.
 */
export const CONFIG_PATH =
  process.env.ORCA_YEELIGHT_CONFIG || path.join(os.homedir(), '.orca', 'yeelight.json');

export const DEFAULT_CONFIG = {
  /** Master switch; the `yeelight.toggle` command flips this. */
  enabled: true,
  /** Scan the LAN at startup and adopt every Yeelight that answers. */
  autoDiscover: true,
  /**
   * Devices to talk to regardless of discovery. Fill this in when multicast is
   * blocked on your network, or to pin a specific light.
   * Example: [{ "host": "192.168.1.50", "name": "Desk cube" }]
   */
  devices: [],
  /**
   * Hearts mode. Instead of one colour for the busiest project, the room shows
   * three hearts, one per agent: blue pulsing while it works, yellow pulsing
   * when it wants you, rainbow when it is doing nothing. With three or more
   * lights each light is one heart; with fewer, every light beats through all
   * three in turn. All idle means three rainbow hearts, a third of the hue
   * wheel apart, so one rainbow spans the room.
   *
   * This replaces the project mapping below on every unassigned light, and the
   * lights stay lit when idle rather than switching off.
   */
  hearts: false,
  /**
   * With several projects running at once:
   *   "cycle"    — one light steps through each project's status colour
   *   "priority" — one light shows only the most urgent status
   * With a single project both behave identically.
   */
  multiProject: 'cycle',
  /** How long each project's colour is held during a cycle, in milliseconds. */
  projectCycleMs: 1400,
  /** Treat each worktree as a project ("worktree"), or each repo ("repo"). */
  groupBy: 'worktree',
  /**
   * Bind a light to one project so it ignores everything else. `match` is
   * matched against the worktree name or path.
   * Example: [{ "match": "yeelight-orca", "device": "192.168.1.50" }]
   */
  assignments: [],
  /** Scales every scene's brightness — 0.5 halves it, for a dim room. */
  brightnessScale: 1,
  /** Fade time for solid colour changes, in milliseconds. */
  transitionMs: 400,
  /** Colour and effect per agent status. effect: solid | breathe | pulse | off */
  scenes: DEFAULT_SCENES,
  timing: DEFAULT_TIMING
};

const SCENE_STATUSES = Object.keys(DEFAULT_SCENES);
const VALID_EFFECTS = new Set(EFFECTS);
const HEX_COLOR_RE = /^#?[0-9a-f]{3}([0-9a-f]{3})?$/i;
const MULTI_PROJECT_MODES = new Set(['priority', 'cycle']);
const GROUP_BY_MODES = new Set(['worktree', 'repo']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function coerceNumber(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Merges user input over the defaults, dropping anything malformed.
 *
 * A hand-edited config must never be able to crash the worker or leave the
 * light stuck, so this is lenient by design: bad fields fall back and are
 * reported through `warnings` instead of throwing.
 */
export function normalizeConfig(raw) {
  const warnings = [];
  const input = isPlainObject(raw) ? raw : {};
  if (raw !== undefined && !isPlainObject(raw)) {
    warnings.push('config root is not an object; using defaults');
  }

  const devices = [];
  if (input.devices !== undefined) {
    if (!Array.isArray(input.devices)) {
      warnings.push('"devices" must be an array; ignoring it');
    } else {
      for (const [index, entry] of input.devices.entries()) {
        const descriptor = isPlainObject(entry) ? entry : { host: entry };
        const host = typeof descriptor.host === 'string' ? descriptor.host.trim() : '';
        if (!host) {
          warnings.push(`devices[${index}] has no host; skipping`);
          continue;
        }
        devices.push({
          host,
          port: coerceNumber(descriptor.port, 55443, { min: 1, max: 65_535 }),
          name: typeof descriptor.name === 'string' ? descriptor.name : '',
          id: typeof descriptor.id === 'string' && descriptor.id ? descriptor.id : `manual:${host}`,
          // Manual entries cannot be feature-detected, so an empty support list
          // tells the protocol layer to assume the modern command set.
          support: Array.isArray(descriptor.support) ? descriptor.support : []
        });
      }
    }
  }

  const scenes = {};
  for (const status of SCENE_STATUSES) {
    const fallback = DEFAULT_SCENES[status];
    const override = isPlainObject(input.scenes?.[status]) ? input.scenes[status] : {};
    const effect = VALID_EFFECTS.has(override.effect) ? override.effect : fallback.effect;
    if (override.effect !== undefined && !VALID_EFFECTS.has(override.effect)) {
      warnings.push(`scenes.${status}.effect "${override.effect}" is unknown; using "${effect}"`);
    }

    const color =
      typeof override.color === 'string' && HEX_COLOR_RE.test(override.color.trim())
        ? override.color.trim()
        : fallback.color;
    if (override.color !== undefined && color !== override.color?.trim?.()) {
      warnings.push(`scenes.${status}.color is not a hex colour; using ${color ?? 'the default'}`);
    }

    // Palette for the multi-colour effects (cycle / alternate / rainbow).
    let colors;
    if (override.colors !== undefined) {
      if (!Array.isArray(override.colors)) {
        warnings.push(`scenes.${status}.colors must be an array; ignoring it`);
      } else {
        colors = override.colors
          .filter((entry) => typeof entry === 'string' && HEX_COLOR_RE.test(entry.trim()))
          .map((entry) => entry.trim())
          .slice(0, 8);
        if (colors.length !== override.colors.length) {
          warnings.push(`scenes.${status}.colors dropped entries that are not hex colours`);
        }
        if (colors.length === 0) colors = undefined;
      }
    }

    scenes[status] = {
      ...fallback,
      effect,
      ...(color ? { color } : {}),
      ...(colors ? { colors } : {}),
      brightness: coerceNumber(override.brightness, fallback.brightness ?? 100, { min: 1, max: 100 }),
      minBrightness: coerceNumber(override.minBrightness, fallback.minBrightness ?? 20, {
        min: 1,
        max: 100
      }),
      periodMs: coerceNumber(override.periodMs, fallback.periodMs ?? 2000, { min: 200, max: 60_000 })
    };
  }

  const assignments = [];
  if (input.assignments !== undefined) {
    if (!Array.isArray(input.assignments)) {
      warnings.push('"assignments" must be an array; ignoring it');
    } else {
      for (const [index, entry] of input.assignments.entries()) {
        const match = isPlainObject(entry) && typeof entry.match === 'string' ? entry.match.trim() : '';
        const device = isPlainObject(entry) && typeof entry.device === 'string' ? entry.device.trim() : '';
        if (!match || !device) {
          warnings.push(`assignments[${index}] needs both "match" and "device"; skipping`);
          continue;
        }
        assignments.push({ match, device });
      }
    }
  }

  const multiProject = MULTI_PROJECT_MODES.has(input.multiProject) ? input.multiProject : 'cycle';
  if (input.multiProject !== undefined && !MULTI_PROJECT_MODES.has(input.multiProject)) {
    warnings.push(`"multiProject" must be "cycle" or "priority"; using "${multiProject}"`);
  }

  const groupBy = GROUP_BY_MODES.has(input.groupBy) ? input.groupBy : 'worktree';
  if (input.groupBy !== undefined && !GROUP_BY_MODES.has(input.groupBy)) {
    warnings.push(`"groupBy" must be "worktree" or "repo"; using "${groupBy}"`);
  }

  return {
    config: {
      enabled: input.enabled !== false,
      autoDiscover: input.autoDiscover !== false,
      devices,
      // Opt-in: it takes the lights over completely, so only an explicit
      // `true` turns it on.
      hearts: input.hearts === true,
      multiProject,
      groupBy,
      projectCycleMs: coerceNumber(input.projectCycleMs, 1400, { min: 200, max: 10_000 }),
      assignments,
      brightnessScale: coerceNumber(input.brightnessScale, 1, { min: 0.05, max: 1 }),
      transitionMs: coerceNumber(input.transitionMs, 400, { min: 30, max: 10_000 }),
      scenes,
      timing: {
        doneHoldMs: coerceNumber(input.timing?.doneHoldMs, DEFAULT_TIMING.doneHoldMs, {
          min: 1000,
          max: 3_600_000
        }),
        staleAfterMs: coerceNumber(input.timing?.staleAfterMs, DEFAULT_TIMING.staleAfterMs, {
          min: 10_000,
          max: 24 * 3_600_000
        })
      }
    },
    warnings
  };
}

/** Reads and normalises the config, writing defaults if the file is absent. */
export async function loadConfig({ configPath = CONFIG_PATH, log = () => {} } = {}) {
  let raw;
  try {
    raw = JSON.parse(await fsp.readFile(configPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      await writeDefaultConfig(configPath).catch((writeError) => {
        log(`could not write default config: ${writeError.message}`);
      });
    } else {
      log(`config is unreadable (${error.message}); using defaults`);
    }
    raw = undefined;
  }

  const { config, warnings } = normalizeConfig(raw);
  for (const warning of warnings) log(`config: ${warning}`);
  return config;
}

async function writeDefaultConfig(configPath) {
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  const seed = {
    $schema: 'https://github.com/ItzYanick/yeelight-orca#configuration',
    ...DEFAULT_CONFIG
  };
  // `wx` so two workers racing at first start cannot clobber each other.
  await fsp.writeFile(configPath, `${JSON.stringify(seed, null, 2)}\n`, { flag: 'wx' });
}

/**
 * Watches the config file and invokes `onChange` with the reloaded config.
 *
 * Editors write via rename, which invalidates the watch, so the watcher is
 * re-armed on every event and changes are debounced into a single reload.
 */
export function watchConfig({ configPath = CONFIG_PATH, onChange, log = () => {} } = {}) {
  let watcher = null;
  let debounce = null;
  let stopped = false;

  const reload = () => {
    debounce = null;
    loadConfig({ configPath, log })
      .then((config) => onChange(config))
      .catch((error) => log(`config reload failed: ${error.message}`));
  };

  const arm = () => {
    if (stopped) return;
    try {
      watcher?.close();
      watcher = fs.watch(configPath, { persistent: false }, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(reload, 250);
        debounce.unref?.();
        // Re-arm after a rename so the watch survives an editor's atomic save.
        setTimeout(arm, 300).unref?.();
      });
      watcher.on('error', () => {
        setTimeout(arm, 2000).unref?.();
      });
    } catch {
      // The file may not exist yet; try again shortly.
      setTimeout(arm, 2000).unref?.();
    }
  };

  arm();

  return () => {
    stopped = true;
    if (debounce) clearTimeout(debounce);
    watcher?.close();
  };
}
