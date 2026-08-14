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
  // Agent is churning: calm steady blue.
  working: {
    color: '#1e6bff',
    brightness: 70,
    effect: 'solid'
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

  if (effect === 'breathe' || effect === 'pulse') {
    const period = Math.max(200, Math.round(definition.periodMs ?? 2000));
    const low = Math.min(
      brightness,
      Math.max(1, Math.round((definition.minBrightness ?? 20) * scale))
    );
    // A breath is a smooth ramp each way; a pulse snaps bright then decays,
    // which reads as more urgent at the same period.
    const steps =
      effect === 'breathe'
        ? [
            { duration: period / 2, mode: 1, color, brightness: low },
            { duration: period / 2, mode: 1, color, brightness }
          ]
        : [
            { duration: 50, mode: 1, color, brightness },
            { duration: period / 2, mode: 1, color, brightness: low },
            { duration: 50, mode: 1, color, brightness },
            { duration: period / 2, mode: 1, color, brightness: low }
          ];

    // count 0 = repeat forever; action 0 = restore prior state when stopped.
    return { status, power: 'on', color, brightness, flow: { steps, count: 0, action: 0 } };
  }

  throw new Error(`unknown scene effect: ${effect}`);
}
