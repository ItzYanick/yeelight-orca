/**
 * Ties everything together: owns the device set, tracks agent status, and
 * pushes the resolved scene to every light.
 *
 * Shared by the plugin worker and the standalone CLI so both drive the lights
 * through exactly one code path.
 */

import { YeelightDevice } from './device.mjs';
import { discoverDevices } from './discovery.mjs';
import { MatrixPanel, probeMatrix } from './matrix-driver.mjs';
import {
  AgentStatusTracker,
  IDLE_STATUS,
  idleHearts,
  resolveHeartsScene,
  resolveProjectCycleScene,
  resolveScene
} from './scene.mjs';

/** How often to re-evaluate so `done` decays to idle without a new event. */
const TICK_INTERVAL_MS = 5000;

export class YeelightController {
  #devices = new Map();
  #tracker;
  #config;
  #tick = null;
  #currentStatus = IDLE_STATUS;
  #projects = [];
  #hearts = [];
  #signature = '';
  /** Device keys that answered the direct-mode probe: matrix panels. */
  #matrixKeys = new Set();
  /** Live frame loops, keyed the same way. A panel here owns its light. */
  #panels = new Map();
  /** Frame rate, pool size and blanking schedule; overridden by the tests. */
  #matrixOptions = {};
  #log;
  #onStatusChange;

  constructor(config, { log = () => {}, onStatusChange = () => {}, matrix = {} } = {}) {
    this.#config = config;
    this.#log = log;
    this.#onStatusChange = onStatusChange;
    this.#matrixOptions = matrix;
    this.#tracker = new AgentStatusTracker(config.timing);
  }

  get status() {
    return this.#currentStatus;
  }

  get config() {
    return this.#config;
  }

  get devices() {
    return [...this.#devices.values()];
  }

  get tracker() {
    return this.#tracker;
  }

  /** Connects configured devices, optionally scanning the LAN as well. */
  async start() {
    await this.#syncDevicesFromConfig();

    if (this.#config.autoDiscover) {
      await this.discover();
    }

    if (this.#devices.size === 0) {
      this.#log(
        'no Yeelight devices found. Enable "LAN Control" in the Yeelight app, ' +
          'or add the light\'s IP to the "devices" list in the config file.'
      );
    }

    this.#tick = setInterval(() => this.refresh(), TICK_INTERVAL_MS);
    this.#tick.unref?.();
    this.refresh();
  }

  async #syncDevicesFromConfig() {
    for (const descriptor of this.#config.devices) {
      this.#adoptDevice(descriptor);
    }
  }

  /** Scans the network and adopts anything new. Returns the devices found. */
  async discover({ timeoutMs } = {}) {
    const found = await discoverDevices({ timeoutMs, log: this.#log });
    for (const descriptor of found) {
      this.#adoptDevice(descriptor);
    }
    return found;
  }

  #adoptDevice(descriptor) {
    // Address by host:port: a device that changed DHCP lease is a new endpoint
    // even when its Yeelight id is unchanged.
    const key = `${descriptor.host}:${descriptor.port ?? 55443}`;
    const existing = this.#devices.get(key);
    if (existing) {
      // Discovery knows the real capability list; a manual entry does not.
      if (descriptor.support?.length) existing.support = descriptor.support;
      if (descriptor.name && !existing.name) existing.name = descriptor.name;
      return existing;
    }

    const device = new YeelightDevice(
      { ...descriptor, transitionMs: this.#config.transitionMs },
      {
        log: this.#log,
        onStateChange: () => this.#onStatusChange(this.summary())
      }
    );
    this.#devices.set(key, device);
    this.#log(`adopted ${device.label} [${device.model}]`);

    device.connect().catch((error) => {
      this.#log(`could not reach ${device.label}: ${error.message}`);
    });

    // Bring the new light straight to the current scene.
    device.setScene(this.#sceneForDevice(device, this.#projects, this.#heartSlots().get(key)));

    // Is it a panel? `support` is empty on these models, so the only way to
    // know is to ask whether it accepts direct mode. Done off the hot path
    // because it costs a connection and a round trip.
    probeMatrix(device.host, device.port)
      .then((isMatrix) => {
        // The device may have been replaced or dropped while we were asking.
        if (!isMatrix || this.#devices.get(key) !== device) return;
        this.#matrixKeys.add(key);
        this.#log(`${device.label} is a matrix panel; hearts can be drawn on it`);
        this.#syncPanels();
        // The probe leaves the panel in direct mode with nothing to show, so
        // repaint: either the frame loop takes over, or a normal scene does.
        this.refresh();
      })
      .catch(() => {
        // A light that cannot be probed is simply treated as a bulb.
      });

    return device;
  }

  /** Hearts are only drawn as sprites when the mode is actually on. */
  #heartsActive() {
    return Boolean(this.#config.enabled && this.#config.hearts);
  }

  /**
   * Starts a frame loop for every matrix panel, or tears them all down.
   *
   * A panel cannot be driven by both paths at once: pushing a scene would take
   * it out of direct mode mid-animation, and the frame loop would fight it
   * back. So a light with a live panel here is skipped by `refresh`.
   */
  #syncPanels() {
    const wanted = this.#heartsActive() ? this.#matrixKeys : new Set();

    for (const [key, panel] of this.#panels) {
      if (wanted.has(key) && this.#devices.has(key)) continue;
      this.#panels.delete(key);
      // Blanks on the way out, so a stopped panel goes dark rather than
      // freezing on half a ripple.
      void panel.close().catch(() => {});
      this.#devices.get(key)?.resume();
      this.#log('stopped driving a panel; it will follow normal scenes again');
    }

    for (const key of wanted) {
      if (this.#panels.has(key)) {
        // Already running — restart the loop so reloaded colours take effect.
        this.#startPanel(this.#panels.get(key));
        continue;
      }

      const device = this.#devices.get(key);
      if (!device) continue;

      const panel = new MatrixPanel(
        { host: device.host, port: device.port },
        { log: this.#log, ...this.#matrixOptions }
      );
      this.#panels.set(key, panel);
      panel
        .open()
        .then(() => {
          // Guard against a teardown that happened while we were connecting.
          if (this.#panels.get(key) !== panel) return void panel.close();
          // Stop the scene path touching this light, including any write still
          // sitting in its coalescing window.
          device.suspend();
          this.#startPanel(panel);
          this.#log(`drawing hearts on ${device.label}`);
        })
        .catch((error) => {
          this.#log(`could not drive ${device.label} as a panel: ${error.message}`);
          this.#panels.delete(key);
          device.resume();
          this.refresh();
        });
    }
  }

  /** Points a panel's loop at the live hearts and the current palette. */
  #startPanel(panel) {
    panel.start(() => (this.#hearts.length > 0 ? this.#hearts : idleHearts()), {
      scenes: this.#config.scenes,
      brightnessScale: this.#config.brightnessScale
    });
  }

  /**
   * Which heart each light carries.
   *
   * Sorted by address rather than adoption order so a light keeps the same
   * heart across restarts and rediscoveries — the mapping is only useful if it
   * is the same one you learned yesterday. Assigned lights are left out: they
   * were deliberately bound to a project, so hearts lay themselves out across
   * whatever is left.
   */
  #heartSlots() {
    const keys = [...this.#devices.entries()]
      .filter(([, device]) => !this.#assignmentFor(device))
      .map(([key]) => key)
      .sort();
    return new Map(keys.map((key, deviceIndex) => [key, { deviceIndex, deviceCount: keys.length }]));
  }

  /** Feeds an `agent.status.changed` payload in and repaints if needed. */
  handleAgentStatus(payload) {
    const changed = this.#tracker.update(payload);
    if (changed) this.refresh();
    return changed;
  }

  /** Drops the panes of a removed worktree so a stale light does not linger. */
  handleWorktreeRemoved(worktreeId) {
    if (this.#tracker.removeWorktree(worktreeId) > 0) this.refresh();
  }

  /** The assignment binding a light to one project, if the user set one. */
  #assignmentFor(device) {
    const assignments = this.#config.assignments ?? [];
    return assignments.find((assignment) => {
      const target = assignment.device.toLowerCase();
      return [device.host, device.name, device.id].some(
        (candidate) => candidate && candidate.toLowerCase() === target
      );
    });
  }

  /** Finds the project an assignment points at, by name, path, or id. */
  #projectFor(match, projects) {
    const needle = match.toLowerCase();
    return projects.find((project) => `${project.label} ${project.key}`.toLowerCase().includes(needle));
  }

  /**
   * The scene one light should show.
   *
   * An assigned light tracks only its project. Everything else shows the whole
   * picture — one heart per agent in hearts mode, otherwise the single most
   * urgent status or a cycle through every running project.
   */
  #sceneForDevice(device, projects, slot) {
    const options = { brightnessScale: this.#config.brightnessScale };

    if (!this.#config.enabled) {
      return resolveScene(IDLE_STATUS, this.#config.scenes, options);
    }

    const assignment = this.#assignmentFor(device);
    if (assignment) {
      const project = this.#projectFor(assignment.match, projects);
      return resolveScene(project?.status ?? IDLE_STATUS, this.#config.scenes, options);
    }

    if (this.#config.hearts) {
      return resolveHeartsScene(this.#hearts, this.#config.scenes, {
        ...options,
        ...(slot ?? { deviceIndex: 0, deviceCount: 1 })
      });
    }

    if (this.#config.multiProject === 'cycle') {
      return resolveProjectCycleScene(projects, this.#config.scenes, {
        ...options,
        periodMs: this.#config.projectCycleMs
      });
    }

    return resolveScene(this.#currentStatus, this.#config.scenes, options);
  }

  /** Recomputes per-project status and pushes a scene to every device. */
  refresh() {
    const now = Date.now();
    const enabled = this.#config.enabled;

    const projects = enabled ? this.#tracker.projects(now, { groupBy: this.#config.groupBy }) : [];
    const status = enabled ? this.#tracker.dominantStatus(now) : IDLE_STATUS;
    const hearts = enabled && this.#config.hearts ? this.#tracker.hearts(now) : [];

    // A project count change matters even when the dominant status does not:
    // a second blocked project must re-render the cycle. The same goes for the
    // hearts: their ordered states are exactly what the lights draw.
    const signature =
      `${status}:${projects.map((p) => `${p.key}=${p.status}`).join(',')}` +
      `|${hearts.map((heart) => heart.state).join(',')}`;
    const changed = signature !== this.#signature;

    this.#currentStatus = status;
    this.#projects = projects;
    this.#hearts = hearts;
    this.#signature = signature;

    const slots = this.#heartSlots();
    for (const [key, device] of this.#devices) {
      // A panel being animated frame by frame must not also be sent scenes.
      if (this.#panels.has(key)) continue;
      device.setScene(this.#sceneForDevice(device, projects, slots.get(key)));
    }

    if (changed) {
      const detail = hearts.length
        ? ` — hearts ${hearts.map((heart) => heart.state).join('/')}`
        : projects.length > 1
          ? ` across ${projects.length} projects`
          : '';
      this.#log(`status -> ${status}${detail}`);
      this.#onStatusChange(this.summary());
    }
    return status;
  }

  /** Applies a scene directly, bypassing status resolution (test command). */
  applyScene(scene) {
    for (const device of this.#devices.values()) {
      device.setScene(scene);
    }
  }

  /** Swaps in a reloaded config without dropping live connections. */
  updateConfig(config) {
    const previous = this.#config;
    this.#config = config;
    this.#tracker.setTiming(config.timing);

    for (const device of this.#devices.values()) {
      device.transitionMs = config.transitionMs;
    }

    // Adopt devices added to the file since the last load.
    for (const descriptor of config.devices) this.#adoptDevice(descriptor);

    if (!previous.enabled && config.enabled) this.#log('sync enabled');
    if (previous.enabled && !config.enabled) this.#log('sync disabled; lights going idle');

    // Starts, stops, or re-points the frame loops to match the reloaded config.
    this.#syncPanels();
    this.refresh();
  }

  summary() {
    return {
      enabled: this.#config.enabled,
      status: this.#currentStatus,
      counts: this.#tracker.countsByStatus(),
      hearts: this.#config.hearts
        ? this.#hearts.map(({ index, state, label }) => ({ index, state, label }))
        : null,
      projects: this.#projects.map(({ label, status, panes }) => ({ label, status, panes })),
      devices: this.devices.map((device) => ({
        id: device.id,
        label: device.label,
        model: device.model,
        connected: device.connected,
        lastError: device.lastError
      }))
    };
  }

  /**
   * Async because a panel has to be blanked before its sockets close, and
   * getting a blank frame past the request quota takes a few seconds. Skipping
   * that would leave the panel frozen on its last frame, which looks like a
   * crash rather than a clean stop.
   */
  async stop() {
    if (this.#tick) clearInterval(this.#tick);
    this.#tick = null;

    const panels = [...this.#panels.values()];
    this.#panels.clear();
    await Promise.allSettled(panels.map((panel) => panel.close()));

    for (const device of this.#devices.values()) device.close();
    this.#devices.clear();
  }
}
