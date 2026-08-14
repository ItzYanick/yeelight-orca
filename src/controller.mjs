/**
 * Ties everything together: owns the device set, tracks agent status, and
 * pushes the resolved scene to every light.
 *
 * Shared by the plugin worker and the standalone CLI so both drive the lights
 * through exactly one code path.
 */

import { YeelightDevice } from './device.mjs';
import { discoverDevices } from './discovery.mjs';
import {
  AgentStatusTracker,
  IDLE_STATUS,
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
  #signature = '';
  #log;
  #onStatusChange;

  constructor(config, { log = () => {}, onStatusChange = () => {} } = {}) {
    this.#config = config;
    this.#log = log;
    this.#onStatusChange = onStatusChange;
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
    device.setScene(this.#sceneForDevice(device, this.#projects));
    return device;
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
   * picture — either the single most urgent status, or a cycle through every
   * running project when `multiProject` is "cycle".
   */
  #sceneForDevice(device, projects) {
    const options = { brightnessScale: this.#config.brightnessScale };

    if (!this.#config.enabled) {
      return resolveScene(IDLE_STATUS, this.#config.scenes, options);
    }

    const assignment = this.#assignmentFor(device);
    if (assignment) {
      const project = this.#projectFor(assignment.match, projects);
      return resolveScene(project?.status ?? IDLE_STATUS, this.#config.scenes, options);
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

    // A project count change matters even when the dominant status does not:
    // a second blocked project must re-render the cycle.
    const signature = `${status}:${projects.map((p) => `${p.key}=${p.status}`).join(',')}`;
    const changed = signature !== this.#signature;

    this.#currentStatus = status;
    this.#projects = projects;
    this.#signature = signature;

    for (const device of this.#devices.values()) {
      device.setScene(this.#sceneForDevice(device, projects));
    }

    if (changed) {
      const detail = projects.length > 1 ? ` across ${projects.length} projects` : '';
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

    this.refresh();
  }

  summary() {
    return {
      enabled: this.#config.enabled,
      status: this.#currentStatus,
      counts: this.#tracker.countsByStatus(),
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

  stop() {
    if (this.#tick) clearInterval(this.#tick);
    this.#tick = null;
    for (const device of this.#devices.values()) device.close();
    this.#devices.clear();
  }
}
