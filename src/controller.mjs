/**
 * Ties everything together: owns the device set, tracks agent status, and
 * pushes the resolved scene to every light.
 *
 * Shared by the plugin worker and the standalone CLI so both drive the lights
 * through exactly one code path.
 */

import { YeelightDevice } from './device.mjs';
import { discoverDevices } from './discovery.mjs';
import { AgentStatusTracker, IDLE_STATUS, resolveScene } from './scene.mjs';

/** How often to re-evaluate so `done` decays to idle without a new event. */
const TICK_INTERVAL_MS = 5000;

export class YeelightController {
  #devices = new Map();
  #tracker;
  #config;
  #tick = null;
  #currentStatus = IDLE_STATUS;
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
    device.setScene(this.#sceneForCurrentStatus());
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

  #sceneForCurrentStatus() {
    return resolveScene(this.#currentStatus, this.#config.scenes, {
      brightnessScale: this.#config.brightnessScale
    });
  }

  /** Recomputes the dominant status and pushes the scene to every device. */
  refresh() {
    const status = this.#config.enabled ? this.#tracker.dominantStatus() : IDLE_STATUS;
    const changed = status !== this.#currentStatus;
    this.#currentStatus = status;

    const scene = this.#sceneForCurrentStatus();
    for (const device of this.#devices.values()) {
      device.setScene(scene);
    }

    if (changed) {
      this.#log(`status -> ${status}`);
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
