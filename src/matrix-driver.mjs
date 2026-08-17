/**
 * Drives a Yeelight matrix panel in `direct` mode.
 *
 * A panel animates nothing by itself, so frames have to be pushed continuously.
 * The obstacle is the firmware's request quota, which rejects roughly anything
 * past one command per second with `error -1 client quota exceeded` — measured,
 * not guessed: 2 fps was clean in bursts, 5 fps lost 28 of 40 frames.
 *
 * The quota turned out to be enforced **per connection**, so this opens a small
 * pool and round-robins frames across it. Six sockets sustained ~8 fps in
 * testing, which is enough for a ripple to read as motion. (Music mode, the
 * documented way to escape the rate limit on bulbs, is not implemented on this
 * model: `set_music` is never acknowledged and the device never dials back.)
 *
 * Dropped frames are survivable by construction — every frame is absolute, not
 * a delta, so a rejected one costs a moment of animation and nothing else.
 */

import net from 'node:net';

import { YEELIGHT_CONTROL_PORT } from './protocol.mjs';
import { blankPayload, renderHeartsPayload } from './matrix.mjs';

/**
 * Sockets to spread frames across, and the rate to aim for.
 *
 * Throughput measurements on a Cube Lite, 40s per setting with eight sockets:
 *
 *   8 fps (1.00/s per socket)   9% rejected   7.2 fps effective
 *   6 fps (0.75/s per socket)   3% rejected   5.8 fps effective
 *   5 fps (0.63/s per socket)   0% rejected   5.0 fps effective
 *
 * Those numbers are real but they are not the whole story, and chasing them
 * was a mistake. Sustained over a longer session, eight sockets — plus the
 * ordinary device connection reconnecting alongside them — drove the firmware
 * into a state where it accepted every TCP connection and closed it again
 * within 20ms, and stayed there through several minutes of complete silence.
 * Only a power cycle cleared it.
 *
 * So the limit that matters is not how many frames the device will accept in a
 * burst; it is how much connection churn it will tolerate for hours. These
 * defaults are deliberately well inside that: four sockets, four frames a
 * second. The ripple was tuned to stay smooth at low frame rates anyway, and a
 * still panel sends almost nothing because unchanged frames are skipped.
 */
export const DEFAULT_POOL_SIZE = 4;
export const DEFAULT_FPS = 4;

const CONNECT_TIMEOUT_MS = 5000;
/**
 * How often an unchanged frame is resent anyway, so a still panel recovers
 * from a frame the quota happened to reject.
 */
const RESEND_INTERVAL_MS = 3000;
/** How long to wait for `activate_fx_mode` to be acknowledged when probing. */
const PROBE_TIMEOUT_MS = 3000;

function connect(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out connecting to ${host}:${port}`));
    }, CONNECT_TIMEOUT_MS);

    socket.setNoDelay(true);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * Is this light a matrix panel?
 *
 * `support` is empty on these models, so nothing can be feature-detected the
 * normal way. `activate_fx_mode {"mode":"direct"}` is the probe instead: the
 * panel answers `ok`, and it is the only mode value the firmware accepts, so a
 * light that acknowledges it can be driven pixel by pixel. Anything else — an
 * error, or silence — is treated as a plain bulb, which is the safe default.
 */
export async function probeMatrix(host, port = YEELIGHT_CONTROL_PORT) {
  let socket;
  try {
    socket = await connect(host, port);
  } catch {
    return false;
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.on('data', (chunk) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/).filter(Boolean)) {
        try {
          const message = JSON.parse(line);
          if (message.id === 1) finish(!message.error);
        } catch {
          // Ignore anything unparseable; the timeout is the backstop.
        }
      }
    });
    socket.on('error', () => finish(false));
    setTimeout(() => finish(false), PROBE_TIMEOUT_MS);

    socket.write(`${JSON.stringify({ id: 1, method: 'activate_fx_mode', params: [{ mode: 'direct' }] })}\r\n`);
  });
}

export class MatrixPanel {
  #host;
  #port;
  #pool = [];
  #timer = null;
  #nextSocket = 0;
  #id = 1;
  #startedAt = 0;
  #log;
  #fps;
  #poolSize;

  #sent = 0;
  #rejected = 0;
  #lastPayload = null;
  #lastPushAt = 0;

  #blankAttempts;
  #blankSpacingMs;

  constructor(
    { host, port = YEELIGHT_CONTROL_PORT },
    {
      log = () => {},
      fps = DEFAULT_FPS,
      poolSize = DEFAULT_POOL_SIZE,
      blankAttempts = 6,
      blankSpacingMs = 1100
    } = {}
  ) {
    this.#host = host;
    this.#port = port;
    this.#log = log;
    this.#fps = Math.min(12, Math.max(1, fps));
    this.#poolSize = Math.min(8, Math.max(1, poolSize));
    this.#blankAttempts = Math.max(1, blankAttempts);
    this.#blankSpacingMs = Math.max(0, blankSpacingMs);
  }

  get stats() {
    return { sent: this.#sent, rejected: this.#rejected };
  }

  /**
   * Fills the frame pool and puts the panel into direct mode.
   *
   * Setup goes over the first pooled socket rather than a connection of its
   * own: these panels tolerate only a handful of simultaneous clients, and one
   * socket held for two commands is one the pool cannot have.
   */
  async open() {
    for (let n = 0; n < this.#poolSize; n += 1) {
      try {
        const socket = await connect(this.#host, this.#port);
        this.#watch(socket);
        this.#pool.push(socket);
      } catch (error) {
        this.#log(`frame connection ${n} failed: ${error.message}`);
      }
    }

    if (this.#pool.length === 0) throw new Error('no frame connections could be opened');

    this.#send(this.#pool[0], 'set_power', ['on', 'smooth', 300]);
    this.#send(this.#pool[0], 'activate_fx_mode', [{ mode: 'direct' }]);
    this.#log(`matrix ready on ${this.#host} (${this.#pool.length} frame connections)`);
  }

  #watch(socket) {
    socket.on('data', (chunk) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/).filter(Boolean)) {
        try {
          const message = JSON.parse(line);
          // Frames are fire-and-forget; a reply is always a complaint.
          if (message.error) this.#rejected += 1;
        } catch {
          // Not worth tearing anything down for.
        }
      }
    });
    socket.on('error', (error) => this.#log(`frame socket error: ${error.message}`));
  }

  #send(socket, method, params) {
    if (!socket || socket.destroyed) return;
    socket.write(`${JSON.stringify({ id: this.#id++, method, params })}\r\n`);
  }

  /**
   * Pushes one already-encoded frame, round-robin across the pool.
   *
   * An unchanged frame is skipped: a panel with nothing running shows a still
   * rainbow, and resending it eight times a second would spend the whole
   * request budget saying nothing — leaving none for the moment something
   * actually changes. It is still resent occasionally, because a frame the
   * quota rejected leaves the panel showing something stale and no later frame
   * would differ enough to correct it.
   */
  push(payload, { force = false } = {}) {
    const now = Date.now();
    const unchanged = payload === this.#lastPayload;
    if (!force && unchanged && now - this.#lastPushAt < RESEND_INTERVAL_MS) return;

    // A socket the device closed is not replaced: reconnecting into a firmware
    // that is already unhappy is what caused trouble in the first place. The
    // loop simply runs on whatever is left.
    const alive = this.#pool.filter((socket) => !socket.destroyed);
    if (alive.length === 0) {
      if (this.#timer) {
        this.#log('every frame connection was closed by the device; stopping the loop');
        this.stop();
      }
      return;
    }

    this.#lastPayload = payload;
    this.#lastPushAt = now;

    const socket = alive[this.#nextSocket % alive.length];
    this.#nextSocket += 1;
    this.#sent += 1;
    this.#send(socket, 'update_leds', [payload]);
  }

  /**
   * Starts the animation loop. `getHearts` is called once per frame so the
   * display always reflects the tracker's current state without the caller
   * having to push anything.
   */
  start(getHearts, { scenes, brightnessScale = 1 } = {}) {
    this.stop();
    this.#startedAt = Date.now();

    const interval = Math.round(1000 / this.#fps);
    this.#timer = setInterval(() => {
      try {
        const payload = renderHeartsPayload(getHearts(), {
          elapsedMs: Date.now() - this.#startedAt,
          scenes,
          brightnessScale
        });
        this.push(payload);
      } catch (error) {
        this.#log(`frame render failed: ${error.message}`);
      }
    }, interval);
    this.#timer.unref?.();
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Queues one blank frame. Prefer `blankAndFlush` when shutting down. */
  blank() {
    // Forced: blanking relies on repeated identical sends to beat the quota,
    // which is exactly what the duplicate check would suppress.
    this.push(blankPayload(), { force: true });
  }

  /**
   * Blanks the panel and waits for it to actually take effect.
   *
   * Two things make the naive version fail, and both were observed: a single
   * blank arriving right after a burst is refused by the quota, and destroying
   * a socket immediately after writing discards the unflushed frame. So this
   * pushes several times, spaced widely enough that at least one lands on a
   * socket with budget left, and returns only once they have gone out.
   *
   * Worth the few seconds: a panel left holding its last frame looks like a
   * crashed display rather than a stopped one.
   */
  async blankAndFlush({ attempts = this.#blankAttempts, spacingMs = this.#blankSpacingMs } = {}) {
    for (let n = 0; n < attempts; n += 1) {
      try {
        this.blank();
      } catch {
        // Nothing to do but keep trying the remaining attempts.
      }
      await new Promise((resolve) => setTimeout(resolve, spacingMs));
    }
  }

  async close({ blank = true } = {}) {
    this.stop();
    if (blank && this.#pool.length > 0) await this.blankAndFlush();
    for (const socket of this.#pool) socket.destroy();
    this.#pool = [];
  }
}
