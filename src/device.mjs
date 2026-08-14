/**
 * A single Yeelight device: connection lifecycle, request/response
 * correlation, rate limiting, and scene application.
 *
 * The plugin worker is long-lived, so a device holds one persistent TCP
 * connection and reconnects with backoff. Writes are coalesced and budgeted:
 * the firmware silently drops a connection that exceeds roughly 60 commands a
 * minute, and a burst of agent-status events must never be able to trip that.
 */

import net from 'node:net';

import {
  YEELIGHT_CONTROL_PORT,
  YEELIGHT_RATE_LIMIT_PER_MINUTE,
  decodeMessages,
  encodeCommand,
  sceneFingerprint,
  sceneToCommands
} from './protocol.mjs';

const CONNECT_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 5000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60_000;
/** Coalescing window: several status flips inside it collapse to one write. */
const WRITE_COALESCE_MS = 350;

export class YeelightDevice {
  #socket = null;
  #buffer = '';
  #nextId = 1;
  #pending = new Map();
  #connecting = null;
  #reconnectTimer = null;
  #reconnectAttempts = 0;
  #closed = false;

  #writeTimer = null;
  #flushing = false;
  #desiredScene = null;
  #appliedFingerprint = null;
  #writeBudget = [];

  constructor(descriptor, { log = () => {}, onStateChange = () => {} } = {}) {
    this.id = descriptor.id;
    this.host = descriptor.host;
    this.port = descriptor.port ?? YEELIGHT_CONTROL_PORT;
    this.model = descriptor.model ?? 'unknown';
    this.name = descriptor.name || '';
    this.support = descriptor.support ?? [];
    this.transitionMs = descriptor.transitionMs ?? 400;

    this.connected = false;
    this.lastError = null;

    this.log = log;
    this.onStateChange = onStateChange;
  }

  get label() {
    return this.name ? `${this.name} (${this.host})` : this.host;
  }

  /** Opens the control connection, reusing an in-flight attempt. */
  connect() {
    if (this.#closed) return Promise.reject(new Error('device is closed'));
    if (this.connected) return Promise.resolve();
    if (this.#connecting) return this.#connecting;

    this.#connecting = new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      socket.setKeepAlive(true, 30_000);
      socket.setNoDelay(true);

      const onConnectTimeout = setTimeout(() => {
        socket.destroy(new Error(`timed out connecting to ${this.host}:${this.port}`));
      }, CONNECT_TIMEOUT_MS);

      socket.once('connect', () => {
        clearTimeout(onConnectTimeout);
        this.#socket = socket;
        this.connected = true;
        this.lastError = null;
        this.#reconnectAttempts = 0;
        this.#connecting = null;
        this.log(`connected to ${this.label}`);
        this.onStateChange(this);
        // A scene requested while offline is applied as soon as we are back.
        if (this.#desiredScene) this.#scheduleWrite();
        resolve();
      });

      socket.on('data', (chunk) => this.#onData(chunk));

      socket.once('error', (error) => {
        clearTimeout(onConnectTimeout);
        this.lastError = error.message;
        if (!this.connected) {
          this.#connecting = null;
          reject(error);
        }
      });

      socket.once('close', () => {
        clearTimeout(onConnectTimeout);
        const wasConnected = this.connected;
        this.connected = false;
        this.#socket = null;
        this.#buffer = '';
        // Anything still awaiting a reply will never get one.
        for (const [, pending] of this.#pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error('connection closed'));
        }
        this.#pending.clear();
        // The next write must re-send the scene over the new connection.
        this.#appliedFingerprint = null;
        if (wasConnected) {
          this.log(`lost connection to ${this.label}`);
          this.onStateChange(this);
        }
        this.#scheduleReconnect();
      });
    });

    return this.#connecting;
  }

  #onData(chunk) {
    this.#buffer += chunk.toString('utf8');
    const { messages, rest } = decodeMessages(this.#buffer);
    this.#buffer = rest;

    for (const message of messages) {
      // Unsolicited property notifications carry no id; nothing to correlate.
      if (message.id === undefined) continue;
      const pending = this.#pending.get(message.id);
      if (!pending) continue;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? 'device rejected command'));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  #scheduleReconnect() {
    if (this.#closed || this.#reconnectTimer) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.#reconnectAttempts);
    this.#reconnectAttempts += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.connect().catch(() => {
        // `close` fires on failure and schedules the next attempt.
      });
    }, delay);
    // A pending reconnect must not hold the worker process open.
    this.#reconnectTimer.unref?.();
  }

  /** Sends one command and waits for the device's acknowledgement. */
  async send(method, params = []) {
    if (!this.connected) await this.connect();
    const socket = this.#socket;
    if (!socket) throw new Error('not connected');

    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`timed out waiting for ${method}`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();

      this.#pending.set(id, { resolve, reject, timer });
      socket.write(encodeCommand(id, method, params), (error) => {
        if (!error) return;
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  /**
   * Requests a scene. Returns immediately; the write is coalesced and applied
   * on the next tick of the write timer.
   */
  setScene(scene) {
    this.#desiredScene = scene;
    this.#scheduleWrite();
  }

  #scheduleWrite() {
    if (this.#closed || this.#writeTimer) return;
    this.#writeTimer = setTimeout(() => {
      this.#writeTimer = null;
      this.#flush().catch((error) => {
        this.log(`failed to apply scene on ${this.label}: ${error.message}`);
      });
    }, WRITE_COALESCE_MS);
    this.#writeTimer.unref?.();
  }

  /** Token bucket over a sliding minute, kept under the firmware's limit. */
  #hasWriteBudget(cost) {
    const now = Date.now();
    this.#writeBudget = this.#writeBudget.filter((at) => now - at < 60_000);
    // Leave headroom so a manual command from the palette always gets through.
    return this.#writeBudget.length + cost <= YEELIGHT_RATE_LIMIT_PER_MINUTE - 6;
  }

  #spendWriteBudget(cost) {
    const now = Date.now();
    for (let i = 0; i < cost; i++) this.#writeBudget.push(now);
  }

  /**
   * Applies the newest desired scene, one flush at a time.
   *
   * Serialised deliberately. `connect()` and every `send()` are awaited, so two
   * overlapping flushes can interleave and let an *older* scene reach the
   * device last — while `#appliedFingerprint` records the newer one, so nothing
   * ever corrects it. The visible result is a light stuck on a stale scene,
   * usually "off", that no later status change can recover.
   *
   * The loop re-reads `#desiredScene` after every await, so a scene that
   * changes mid-connect is superseded rather than sent and then overwritten.
   */
  async #flush() {
    if (this.#flushing) return;
    this.#flushing = true;

    try {
      while (!this.#closed) {
        const scene = this.#desiredScene;
        if (!scene) return;

        const fingerprint = sceneFingerprint(scene);
        if (fingerprint === this.#appliedFingerprint) return;

        if (!this.connected) {
          await this.connect();
          // A newer scene may have landed while the connection was opening.
          if (this.#desiredScene !== scene) continue;
        }

        const commands = sceneToCommands(scene, {
          support: this.support,
          transitionMs: this.transitionMs
        });

        if (!this.#hasWriteBudget(commands.length)) {
          // Retry once the sliding window has room rather than dropping the scene.
          this.log(`rate limit reached for ${this.label}; deferring scene`);
          setTimeout(() => this.#scheduleWrite(), 5000).unref?.();
          return;
        }

        this.#spendWriteBudget(commands.length);
        for (const command of commands) {
          await this.send(command.method, command.params);
        }
        this.#appliedFingerprint = fingerprint;

        // Anything newer that arrived mid-write gets its own pass.
        if (this.#desiredScene === scene) return;
      }
    } finally {
      this.#flushing = false;
    }
  }

  /**
   * Reads live properties from the device.
   *
   * `get_prop` is optional in practice: some firmware (the Cube Lite, for one)
   * never answers it — no result, no error, just silence — while accepting
   * every write command. A timeout here therefore means "this model cannot be
   * queried", not "the light is unreachable", and callers are told so.
   */
  async getProperties(names = ['power', 'bright', 'rgb', 'color_mode', 'name']) {
    let values;
    try {
      values = await this.send('get_prop', names);
    } catch (error) {
      if (/timed out/.test(error.message)) {
        const unsupported = new Error('this model does not implement get_prop');
        unsupported.code = 'GET_PROP_UNSUPPORTED';
        throw unsupported;
      }
      throw error;
    }

    const result = {};
    names.forEach((key, index) => {
      result[key] = Array.isArray(values) ? values[index] : undefined;
    });
    return result;
  }

  close() {
    this.#closed = true;
    if (this.#writeTimer) clearTimeout(this.#writeTimer);
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#writeTimer = null;
    this.#reconnectTimer = null;
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('device closed'));
    }
    this.#pending.clear();
    this.#socket?.destroy();
    this.#socket = null;
    this.connected = false;
  }
}
