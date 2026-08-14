/**
 * Agent status -> light scene.
 *
 * Orca reports per-pane agent state as one of `working | blocked | waiting |
 * done` (see the `agent.status.changed` plugin event). Several agents can be
 * running at once, so this module keeps a small table of live panes, collapses
 * it to a single dominant status, and resolves that to a scene.
 *
 * Pure and clock-injected: every decision is testable without a network or a
 * real timer.
 */

import { rainbowPalette } from './protocol.mjs';

/** Highest urgency first — the first match wins when agents disagree. */
export const STATUS_PRIORITY = ['blocked', 'waiting', 'working', 'done'];

export const IDLE_STATUS = 'idle';

export const DEFAULT_SCENES = {
  // Something needs a human: red, urgent double-pulse.
  blocked: {
    color: '#ff1a1a',
    brightness: 100,
    effect: 'pulse',
    periodMs: 900,
    minBrightness: 20
  },
  // Agent is asking a question: amber, slow breath.
  waiting: {
    color: '#ffa000',
    brightness: 90,
    effect: 'breathe',
    periodMs: 2600,
    minBrightness: 25
  },
  // Agent is churning: calm blue, breathing slowly.
  //
  // Deliberately animated even though nothing needs attention: `working` is
  // the state you are in most of the time, and a steady colour there makes a
  // healthy light indistinguishable from a broken one. The range is narrow and
  // the period long so it reads as "alive" rather than "look at me" — the
  // sharper pulse of `blocked` and shorter breath of `waiting` still stand out
  // against it.
  working: {
    color: '#1e6bff',
    brightness: 75,
    effect: 'breathe',
    periodMs: 4000,
    minBrightness: 45
  },
  // Finished: green, held briefly, then the light returns to idle.
  done: {
    color: '#12c46a',
    brightness: 80,
    effect: 'solid'
  },
  // Nothing running.
  idle: {
    effect: 'off'
  }
};

export const DEFAULT_TIMING = {
  /** How long `done` is shown before the light falls back to idle. */
  doneHoldMs: 90_000,
  /**
   * Orca itself treats agent status as stale after 30 minutes; a pane that has
   * not reported inside this window stops influencing the light.
   */
  staleAfterMs: 30 * 60_000
};

/**
 * Tracks the last reported state of every agent pane.
 *
 * Panes are keyed by `paneKey`, which is stable for the lifetime of a pane, so
 * a restarted agent reuses its row rather than leaking a new one.
 */
export class AgentStatusTracker {
  #panes = new Map();
  #timing;

  constructor(timing = {}) {
    this.#timing = { ...DEFAULT_TIMING, ...timing };
  }

  get size() {
    return this.#panes.size;
  }

  /** Applies reloaded timing without discarding the panes already tracked. */
  setTiming(timing = {}) {
    this.#timing = { ...DEFAULT_TIMING, ...timing };
  }

  /** Records an `agent.status.changed` payload. Unknown states are ignored. */
  update({ paneKey, state, worktreeId = null, receivedAt = Date.now() }) {
    if (!paneKey || typeof paneKey !== 'string') return false;
    if (!STATUS_PRIORITY.includes(state)) return false;

    const previous = this.#panes.get(paneKey);
    // Events can arrive out of order after a reconnect; keep the newest.
    if (previous && previous.receivedAt > receivedAt) return false;

    this.#panes.set(paneKey, { state, worktreeId, receivedAt });
    return !previous || previous.state !== state;
  }

  /** Drops every pane belonging to a worktree that no longer exists. */
  removeWorktree(worktreeId) {
    if (!worktreeId) return 0;
    let removed = 0;
    for (const [paneKey, pane] of this.#panes) {
      if (pane.worktreeId === worktreeId) {
        this.#panes.delete(paneKey);
        removed += 1;
      }
    }
    return removed;
  }

  clear() {
    this.#panes.clear();
  }

  /** Forgets panes that have gone quiet for longer than `staleAfterMs`. */
  prune(now = Date.now()) {
    let removed = 0;
    for (const [paneKey, pane] of this.#panes) {
      const age = now - pane.receivedAt;
      const limit = pane.state === 'done' ? this.#timing.doneHoldMs : this.#timing.staleAfterMs;
      if (age > limit) {
        this.#panes.delete(paneKey);
        removed += 1;
      }
    }
    return removed;
  }

  /** Snapshot of live panes, newest first — used by the status command. */
  snapshot(now = Date.now()) {
    return [...this.#panes.entries()]
      .map(([paneKey, pane]) => ({ paneKey, ...pane, ageMs: now - pane.receivedAt }))
      .sort((a, b) => a.ageMs - b.ageMs);
  }

  /**
   * Collapses every live pane into the one status the light should show.
   * Pruning first means an abandoned `working` pane cannot pin the light on.
   */
  dominantStatus(now = Date.now()) {
    this.prune(now);
    if (this.#panes.size === 0) return IDLE_STATUS;

    const live = new Set();
    for (const pane of this.#panes.values()) live.add(pane.state);

    for (const status of STATUS_PRIORITY) {
      if (live.has(status)) return status;
    }
    return IDLE_STATUS;
  }

  /** Count of panes per status, for the status notification. */
  countsByStatus(now = Date.now()) {
    this.prune(now);
    const counts = {};
    for (const pane of this.#panes.values()) {
      counts[pane.state] = (counts[pane.state] ?? 0) + 1;
    }
    return counts;
  }

  /**
   * Groups live panes into projects, each with its own dominant status.
   *
   * This is what makes several concurrent projects legible: instead of one
   * global answer, you get one status per project, ordered most urgent first.
   */
  projects(now = Date.now(), { groupBy = 'worktree' } = {}) {
    this.prune(now);

    const grouped = new Map();
    for (const pane of this.#panes.values()) {
      const identity = parseWorktreeId(pane.worktreeId);
      const key = groupBy === 'repo' ? identity.repoId : identity.key;
      const existing = grouped.get(key) ?? { key, label: identity.label, states: new Set(), panes: 0 };
      existing.states.add(pane.state);
      existing.panes += 1;
      grouped.set(key, existing);
    }

    return [...grouped.values()]
      .map(({ key, label, states, panes }) => ({
        key,
        label,
        panes,
        status: STATUS_PRIORITY.find((status) => states.has(status)) ?? IDLE_STATUS
      }))
      .sort(
        (a, b) =>
          STATUS_PRIORITY.indexOf(a.status) - STATUS_PRIORITY.indexOf(b.status) ||
          a.label.localeCompare(b.label)
      );
  }
}

/**
 * Splits Orca's `<repoId>::<worktreePath>` worktree id.
 *
 * The path is embedded in the id, so a readable project name comes for free —
 * no extra event subscription or host call needed. Anything that does not match
 * the shape is passed through as an opaque key rather than being dropped, so an
 * id format change degrades to "one unnamed project" instead of breaking.
 */
export function parseWorktreeId(worktreeId) {
  if (!worktreeId || typeof worktreeId !== 'string') {
    return { key: 'unknown', repoId: 'unknown', path: '', label: 'unassigned' };
  }

  const separator = worktreeId.indexOf('::');
  if (separator < 0) {
    return { key: worktreeId, repoId: worktreeId, path: '', label: worktreeId };
  }

  const repoId = worktreeId.slice(0, separator);
  const path = worktreeId.slice(separator + 2);
  const label = path.split(/[\\/]/).filter(Boolean).pop() || repoId;
  return { key: worktreeId, repoId, path, label };
}

/**
 * One light, several projects: cycle the light through each project's status
 * colour so you can see both *what* is happening and *how many* are running.
 *
 * Colours snap rather than fade, because a fade between two project colours
 * produces intermediate hues that read as a third, non-existent project.
 */
export function resolveProjectCycleScene(
  projects,
  scenes = DEFAULT_SCENES,
  { brightnessScale = 1, periodMs = 1400 } = {}
) {
  const active = projects.filter((project) => project.status !== IDLE_STATUS).slice(0, 8);

  if (active.length === 0) return resolveScene(IDLE_STATUS, scenes, { brightnessScale });
  if (active.length === 1) return resolveScene(active[0].status, scenes, { brightnessScale });

  const scale = Number.isFinite(brightnessScale) ? brightnessScale : 1;
  const hold = Math.max(50, Math.round(periodMs));

  const steps = active.flatMap((project) => {
    const definition = scenes[project.status] ?? DEFAULT_SCENES[project.status];
    const color = definition?.color ?? '#ffffff';
    const brightness = Math.min(
      100,
      Math.max(1, Math.round((definition?.brightness ?? 100) * scale))
    );
    return [
      { duration: 50, mode: 1, color, brightness },
      { duration: hold, mode: 1, color, brightness }
    ];
  });

  return {
    status: active[0].status,
    power: 'on',
    color: scenes[active[0].status]?.color ?? '#ffffff',
    brightness: 100,
    projects: active.length,
    flow: { steps: steps.slice(0, MAX_FLOW_STEPS), count: 0, action: 0 }
  };
}

/** Effects a scene may request. All but `solid`/`off` become colour flows. */
export const EFFECTS = [
  'solid',
  'breathe',
  'pulse',
  'strobe',
  'alternate',
  'cycle',
  'rainbow',
  'candle',
  'off'
];

/**
 * Flow expressions live in the device's memory, so they must stay short.
 * Sixteen tuples is well inside what every tested model accepts.
 */
export const MAX_FLOW_STEPS = 16;

/** Fixed flicker pattern — deterministic so a scene's fingerprint is stable. */
const CANDLE_PATTERN = [
  [0.35, 1],
  [1, 0.45],
  [0.6, 0.8],
  [0.9, 0.3],
  [0.45, 0.7],
  [0.8, 0.5]
];

/**
 * Expands an effect into colour-flow steps.
 *
 * Separated from `resolveScene` because the multi-project cycle needs the same
 * grammar with a palette it computes itself.
 *
 * A Yeelight flow interpolates *towards* each step's value over that step's
 * duration, so a "snap" is a 50 ms step to the target followed by a hold at the
 * same value. That trick is what separates `alternate`/`strobe` (hard edges)
 * from `cycle`/`breathe` (smooth ramps).
 */
export function buildEffectSteps(effect, { palette, brightness, low, period }) {
  const colors = palette.length > 0 ? palette : ['#ffffff'];
  const slice = Math.max(50, Math.round(period / colors.length));

  switch (effect) {
    case 'breathe':
      return [
        { duration: period / 2, mode: 1, color: colors[0], brightness: low },
        { duration: period / 2, mode: 1, color: colors[0], brightness }
      ];

    case 'pulse':
      // Snap bright, decay slowly: reads as more urgent than a breath.
      return [
        { duration: 50, mode: 1, color: colors[0], brightness },
        { duration: period / 2, mode: 1, color: colors[0], brightness: low },
        { duration: 50, mode: 1, color: colors[0], brightness },
        { duration: period / 2, mode: 1, color: colors[0], brightness: low }
      ];

    case 'strobe':
      // Hard on/off. Brightness 1 rather than 0 — the device treats 0 as unset.
      return [
        { duration: 50, mode: 1, color: colors[0], brightness },
        { duration: Math.max(50, period * 0.2), mode: 1, color: colors[0], brightness },
        { duration: 50, mode: 1, color: colors[0], brightness: 1 },
        { duration: Math.max(50, period * 0.3), mode: 1, color: colors[0], brightness: 1 }
      ];

    case 'alternate':
      // Snap between every colour in the palette, holding each.
      return colors.flatMap((color) => [
        { duration: 50, mode: 1, color, brightness },
        { duration: Math.max(50, slice - 50), mode: 1, color, brightness }
      ]);

    case 'cycle':
    case 'rainbow':
      // Smooth fade through the palette.
      return colors.map((color) => ({ duration: slice, mode: 1, color, brightness }));

    case 'candle':
      return CANDLE_PATTERN.map(([durationScale, brightnessScale]) => ({
        duration: Math.max(50, period * 0.25 * durationScale),
        mode: 1,
        color: colors[0],
        brightness: Math.max(low, Math.round(brightness * brightnessScale))
      }));

    default:
      throw new Error(`unknown scene effect: ${effect}`);
  }
}

/**
 * Resolves a status into a concrete scene the protocol layer can encode.
 *
 * `effect` is expanded here rather than in the protocol layer so users can
 * describe a scene declaratively in config ("breathe this colour") without
 * knowing Yeelight's flow-expression grammar.
 */
export function resolveScene(status, scenes = DEFAULT_SCENES, { brightnessScale = 1 } = {}) {
  const definition = scenes[status] ?? scenes[IDLE_STATUS] ?? DEFAULT_SCENES.idle;
  const effect = definition.effect ?? 'solid';

  if (effect === 'off') {
    return { status, power: 'off' };
  }

  const scale = Number.isFinite(brightnessScale) ? brightnessScale : 1;
  const brightness = Math.min(100, Math.max(1, Math.round((definition.brightness ?? 100) * scale)));
  const color = definition.color ?? '#ffffff';

  if (effect === 'solid') {
    return { status, power: 'on', color, brightness };
  }

  const period = Math.max(200, Math.round(definition.periodMs ?? 2000));
  const low = Math.min(brightness, Math.max(1, Math.round((definition.minBrightness ?? 20) * scale)));

  const palette =
    effect === 'rainbow'
      ? rainbowPalette(definition.colors?.length || 6)
      : (Array.isArray(definition.colors) && definition.colors.length
          ? definition.colors
          : [color]
        ).slice(0, 8);

  const steps = buildEffectSteps(effect, { palette, brightness, low, period });

  // count 0 = repeat forever; action 0 = restore prior state when stopped.
  return {
    status,
    power: 'on',
    color,
    brightness,
    flow: { steps: steps.slice(0, MAX_FLOW_STEPS), count: 0, action: 0 }
  };
}
