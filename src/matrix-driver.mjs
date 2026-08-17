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
 * Measured on a Cube Lite, 40s per setting, eight sockets throughout:
 *
 *   8 fps (1.00/s per socket)   9% rejected   7.2 fps effective
 *   6 fps (0.75/s per socket)   3% rejected   5.8 fps effective
 *   5 fps (0.63/s per socket)   0% rejected   5.0 fps effective
 *
 * 8 fps is chosen over the rejection-free 5 fps because a dropped frame costs
 * nothing: every frame is absolute, so a rejected one is simply skipped and the
 * next is already correct. More updates reach the panel at 8 fps than at 5,
 * drops included, and the ripple is visibly smoother for it.
 */
export const DEFAULT_POOL_SIZE = 8;
export const DEFAULT_FPS = 8;

const CONNECT_TIMEOUT_MS = 5000;
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
  #control = null;
  #timer = null;
  #nextSocket = 0;
  #id = 1;
  #startedAt = 0;
  #log;
  #fps;
  #poolSize;

  #sent = 0;
  #rejected = 0;

  constructor(
    { host, port = YEELIGHT_CONTROL_PORT },
    { log = () => {}, fps = DEFAULT_FPS, poolSize = DEFAULT_POOL_SIZE } = {}
  ) {
    this.#host = host;
    this.#port = port;
    this.#log = log;
    this.#fps = Math.min(12, Math.max(1, fps));
    this.#poolSize = Math.min(8, Math.max(1, poolSize));
  }

  get stats() {
    return { sent: this.#sent, rejected: this.#rejected };
  }

  /** Opens the control connection, enters direct mode, and fills the pool. */
  async open() {
    this.#control = await connect(this.#host, this.#port);
    this.#watch(this.#control);

    this.#send(this.#control, 'set_power', ['on', 'smooth', 300]);
    this.#send(this.#control, 'activate_fx_mode', [{ mode: 'direct' }]);

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

  /** Pushes one already-encoded frame, round-robin across the pool. */
  push(payload) {
    const socket = this.#pool[this.#nextSocket % this.#pool.length];
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

  /** Blanks the panel — otherwise it holds the last frame indefinitely. */
  blank() {
    this.push(blankPayload());
  }

  close({ blank = true } = {}) {
    this.stop();
    if (blank) {
      try {
        this.blank();
      } catch {
        // Closing anyway.
      }
    }
    for (const socket of this.#pool) socket.destroy();
    this.#pool = [];
    this.#control?.destroy();
    this.#control = null;
  }
}
