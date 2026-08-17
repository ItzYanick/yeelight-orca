/**
 * End-to-end test of the plugin entry point.
 *
 * Drives `activate` through the exact contract Orca's plugin worker provides
 * (`commands.register`, `events.on`, `host.call`) against a fake bulb that
 * speaks the real wire protocol, so the assertions are on the bytes a device
 * would actually receive.
 */

import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { decodeMessages, toRgbInt } from '../src/protocol.mjs';
import { DEFAULT_SCENES } from '../src/scene.mjs';

/**
 * Sandboxed by `test/setup.mjs`, which `npm test` loads via `--import` before
 * any module here is evaluated. See that file for why the override cannot
 * live in this one.
 */
const TEST_CONFIG_PATH = process.env.ORCA_YEELIGHT_CONFIG;
assert.ok(TEST_CONFIG_PATH, 'run via `npm test` so the config path is sandboxed');
fsSync.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });

/** Minimal Yeelight that records commands and acknowledges each one. */
function startFakeBulb() {
  const received = [];
  let buffered = '';

  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      buffered += chunk.toString('utf8');
      const { messages, rest } = decodeMessages(buffered);
      buffered = rest;
      for (const message of messages) {
        received.push(message);
        socket.write(`${JSON.stringify({ id: message.id, result: ['ok'] })}\r\n`);
      }
    });
    socket.on('error', () => {});
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        received,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

/** Stands in for Orca's plugin worker runtime. */
function createHostContext() {
  const commands = new Map();
  const events = new Map();
  const storage = new Map();
  const notifications = [];
  const logs = [];

  return {
    notifications,
    logs,
    invoke: (id, args) => commands.get(id)(args),
    emit: async (event, payload) => {
      for (const handler of events.get(event) ?? []) await handler(payload);
    },
    hasCommand: (id) => commands.has(id),
    subscribedEvents: () => [...events.keys()],
    context: {
      commands: { register: (id, handler) => commands.set(id, handler) },
      events: {
        on: (event, handler) => {
          const list = events.get(event) ?? [];
          list.push(handler);
          events.set(event, list);
        }
      },
      host: {
        call: async (method, params) => {
          switch (method) {
            case 'storage.get':
              return { value: storage.get(params.key) ?? null };
            case 'storage.set':
              storage.set(params.key, params.value);
              return { ok: true };
            case 'notifications.show':
              notifications.push(params);
              return { delivered: true };
            case 'events.subscribe':
              return { subscribed: params.events };
            default:
              throw new Error(`unexpected host method ${method}`);
          }
        }
      },
      grantedCapabilities: [
        { kind: 'events:subscribe' },
        { kind: 'notifications:show' },
        { kind: 'storage' }
      ],
      log: (message) => logs.push(String(message))
    }
  };
}

const settle = (ms = 700) => new Promise((resolve) => setTimeout(resolve, ms));

/** Last `set_scene` the bulb saw, which is the scene actually displayed. */
function lastScene(received) {
  return [...received].reverse().find((message) => message.method === 'set_scene');
}

/**
 * Whether a scene displays a colour, in either form: `set_scene ["color", rgb,
 * bright]` for a solid scene or `set_scene ["cf", ...]` for an animated one.
 * Tests assert on what the light *shows*, not on which form it took.
 */
function showsColor(scene, hex) {
  const rgb = toRgbInt(hex);
  return scene.params[0] === 'color'
    ? scene.params[1] === rgb
    : new RegExp(`,1,${rgb},`).test(scene.params[3]);
}

describe('per-project light assignment', () => {
  /**
   * Two lights, two projects, one assignment: the assigned light must follow
   * only its own project while the other keeps showing the whole picture.
   */
  it('routes each project to its assigned light', async () => {
    const alpha = await startFakeBulb();
    const beta = await startFakeBulb();

    const { YeelightController } = await import('../src/controller.mjs');
    const { normalizeConfig } = await import('../src/config.mjs');

    const { config } = normalizeConfig({
      autoDiscover: false,
      devices: [
        { host: '127.0.0.1', port: alpha.port, name: 'alpha-light' },
        { host: '127.0.0.1', port: beta.port, name: 'beta-light' }
      ],
      // Only alpha-light is pinned to a project; beta-light stays global.
      assignments: [{ match: 'alpha', device: 'alpha-light' }]
    });

    const controller = new YeelightController(config, { log: () => {} });
    await controller.start();
    await settle();

    controller.handleAgentStatus({
      paneKey: 'p1',
      state: 'working',
      worktreeId: 'r1::/w/alpha',
      receivedAt: Date.now()
    });
    controller.handleAgentStatus({
      paneKey: 'p2',
      state: 'blocked',
      worktreeId: 'r2::/w/beta',
      receivedAt: Date.now()
    });
    await settle();

    try {
      // The assigned light shows alpha's own status and nothing else.
      const assigned = lastScene(alpha.received);
      assert.ok(showsColor(assigned, DEFAULT_SCENES.working.color), 'alpha is working');
      assert.ok(
        !showsColor(assigned, DEFAULT_SCENES.blocked.color),
        'an assigned light must ignore other projects'
      );

      // The unassigned light cycles both projects, so it must be a flow that
      // contains beta's blocked red -- which the assigned light never shows.
      const global = lastScene(beta.received);
      assert.equal(global.params[0], 'cf');
      assert.match(global.params[3], new RegExp(`,1,${toRgbInt(DEFAULT_SCENES.blocked.color)},`));
      assert.match(global.params[3], new RegExp(`,1,${toRgbInt(DEFAULT_SCENES.working.color)},`));

      const summary = controller.summary();
      assert.equal(summary.projects.length, 2);
      assert.equal(summary.projects[0].status, 'blocked', 'most urgent project first');
    } finally {
      controller.stop();
      await alpha.close();
      await beta.close();
    }
  });
});

describe('overlapping writes', () => {
  /**
   * A scene change that arrives while the connection is still opening must
   * supersede the one being flushed — never land before it.
   *
   * Without serialisation the stale scene reaches the device last while
   * `#appliedFingerprint` records the newer one, so the light sticks (usually
   * off) and no later status change can recover it.
   */
  it('never lets a superseded scene reach the device last', async () => {
    const bulb = await startFakeBulb();
    const { YeelightDevice } = await import('../src/device.mjs');

    const device = new YeelightDevice({
      id: 'slow',
      host: '127.0.0.1',
      port: bulb.port,
      support: ['set_scene']
    });

    // Delay the connection so the first flush is still awaiting it when the
    // second scene arrives — the exact window the race needs.
    const realConnect = device.connect.bind(device);
    device.connect = () =>
      new Promise((resolve, reject) => {
        setTimeout(() => realConnect().then(resolve, reject), 500);
      });

    try {
      device.setScene({ status: 'idle', power: 'off' });
      setTimeout(() => {
        device.setScene({ status: 'working', power: 'on', color: '#1e6bff', brightness: 70 });
      }, 400);

      await settle(2000);

      const last = bulb.received.at(-1);
      assert.ok(last, 'the device should have received something');
      assert.equal(last.method, 'set_scene', 'the colour must land last, not the power-off');
      assert.equal(last.params[1], toRgbInt('#1e6bff'));

      const powerOffs = bulb.received.filter(
        (message) => message.method === 'set_power' && message.params[0] === 'off'
      );
      assert.equal(powerOffs.length, 0, 'the superseded off should never be sent at all');
    } finally {
      device.close();
      await bulb.close();
    }
  });
});

describe('models that ignore get_prop', () => {
  /**
   * Regression test for real Cube Lite firmware: it accepts every write but
   * never answers `get_prop` — no result and no error. That must read as
   * "cannot be queried", not "the light is unreachable".
   */
  it('reports get_prop as unsupported rather than as a dead connection', async () => {
    const server = net.createServer((socket) => {
      let buffered = '';
      socket.on('data', (chunk) => {
        buffered += chunk.toString('utf8');
        const { messages, rest } = decodeMessages(buffered);
        buffered = rest;
        for (const message of messages) {
          if (message.method === 'get_prop') continue; // silently dropped
          socket.write(`${JSON.stringify({ id: message.id, result: ['ok'] })}\r\n`);
        }
      });
      socket.on('error', () => {});
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { YeelightDevice } = await import('../src/device.mjs');
    const device = new YeelightDevice({
      id: 'silent',
      host: '127.0.0.1',
      port: server.address().port
    });

    try {
      await device.connect();
      // A write still succeeds against the same connection.
      assert.deepEqual(await device.send('set_power', ['on', 'smooth', 400]), ['ok']);

      const error = await device.getProperties().then(
        () => null,
        (caught) => caught
      );
      assert.ok(error, 'getProperties should reject');
      assert.equal(error.code, 'GET_PROP_UNSUPPORTED');
      assert.equal(device.connected, true, 'the connection must stay usable');
    } finally {
      device.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('plugin activate()', () => {
  let bulb;
  let harness;
  let activate;
  let deactivate;
  let configPath;

  before(async () => {
    bulb = await startFakeBulb();

    configPath = TEST_CONFIG_PATH;
    await fs.writeFile(
      configPath,
      JSON.stringify({
        enabled: true,
        autoDiscover: false,
        devices: [{ host: '127.0.0.1', port: bulb.port, name: 'Fake bulb' }]
      })
    );

    ({ default: activate, deactivate } = await import('../src/index.mjs'));

    harness = createHostContext();
    await activate(harness.context);
    await settle();
  });

  after(async () => {
    deactivate?.();
    await bulb.close();
    delete process.env.ORCA_YEELIGHT_CONFIG;
  });

  it('registers every contributed command', () => {
    for (const id of [
      'yeelight.discover',
      'yeelight.status',
      'yeelight.test',
      'yeelight.toggle',
      'yeelight.off'
    ]) {
      assert.ok(harness.hasCommand(id), `${id} should be registered`);
    }
  });

  it('subscribes to the events it declares in the manifest', () => {
    assert.deepEqual(harness.subscribedEvents().sort(), ['agent.status.changed', 'worktree.removed']);
  });

  it('connects to the configured light and starts it idle (off)', () => {
    const powerOff = bulb.received.find(
      (message) => message.method === 'set_power' && message.params[0] === 'off'
    );
    assert.ok(powerOff, 'an idle light should be turned off');
  });

  it('turns the light blue while an agent works', async () => {
    await harness.emit('agent.status.changed', {
      paneKey: 'pane-1',
      worktreeId: 'wt-1',
      state: 'working',
      receivedAt: Date.now()
    });
    await settle();

    const scene = lastScene(bulb.received);
    assert.ok(showsColor(scene, DEFAULT_SCENES.working.color), 'should show the working colour');
  });

  it('escalates to a red flow when any agent is blocked', async () => {
    await harness.emit('agent.status.changed', {
      paneKey: 'pane-2',
      worktreeId: 'wt-2',
      state: 'blocked',
      receivedAt: Date.now()
    });
    await settle();

    const scene = lastScene(bulb.received);
    assert.equal(scene.params[0], 'cf', 'blocked pulses, so it must be a colour flow');
    assert.match(scene.params[3], new RegExp(`,1,${toRgbInt(DEFAULT_SCENES.blocked.color)},`));
  });

  it('de-escalates to the next most urgent agent when a worktree is removed', async () => {
    await harness.emit('worktree.removed', { worktreeId: 'wt-2', path: '/tmp/wt-2' });
    await settle();

    const scene = lastScene(bulb.received);
    assert.ok(showsColor(scene, DEFAULT_SCENES.working.color), 'should fall back to working');
    assert.ok(!showsColor(scene, DEFAULT_SCENES.blocked.color), 'the removed project must be gone');
  });

  it('coalesces a burst of events into a single write', async () => {
    const before = bulb.received.length;
    for (const state of ['done', 'working', 'waiting', 'blocked']) {
      await harness.emit('agent.status.changed', {
        paneKey: 'pane-burst',
        worktreeId: 'wt-3',
        state,
        receivedAt: Date.now()
      });
    }
    await settle();

    const writes = bulb.received.length - before;
    assert.ok(writes <= 2, `expected the burst to coalesce, saw ${writes} commands`);
  });

  it('reports status through a notification', async () => {
    const summary = await harness.invoke('yeelight.status');
    assert.equal(summary.devices.length, 1);
    assert.equal(summary.devices[0].connected, true);
    assert.match(harness.notifications.at(-1).body, /1\/1 light connected/);
  });

  it('turns the lights off on command', async () => {
    await harness.invoke('yeelight.off');
    await settle();
    const last = bulb.received.at(-1);
    assert.equal(last.method, 'set_power');
    assert.equal(last.params[0], 'off');
  });

  it('toggles sync off, persists the flag, and forces the lights idle', async () => {
    const result = await harness.invoke('yeelight.toggle');
    assert.equal(result.enabled, false);

    const persisted = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.equal(persisted.enabled, false);

    await harness.emit('agent.status.changed', {
      paneKey: 'pane-9',
      worktreeId: 'wt-9',
      state: 'blocked',
      receivedAt: Date.now()
    });
    await settle();

    const scenesAfter = bulb.received.filter(
      (message) => message.method === 'set_scene' && message.params[0] === 'cf'
    );
    const last = bulb.received.at(-1);
    assert.ok(
      last.method === 'set_power' && last.params[0] === 'off',
      'a disabled sync must leave the light off'
    );
    assert.ok(scenesAfter.length >= 1);
  });
});

describe('hearts on a matrix panel', () => {
  /**
   * The whole panel path, end to end: the fake bulb acknowledges every command,
   * so it probes as a matrix, and the controller must then drive it with frames
   * instead of scenes.
   *
   * The two halves matter equally. Frames arriving proves the loop runs; no
   * `set_scene` arriving proves the two paths are not fighting each other —
   * a scene would knock the panel out of direct mode mid-animation.
   */
  it('drives a panel with frames and stops sending it scenes', async () => {
    const bulb = await startFakeBulb();

    const { YeelightController } = await import('../src/controller.mjs');
    const { normalizeConfig } = await import('../src/config.mjs');
    const { MATRIX_LEDS } = await import('../src/matrix.mjs');

    const { config } = normalizeConfig({
      autoDiscover: false,
      hearts: true,
      devices: [{ host: '127.0.0.1', port: bulb.port, name: 'panel' }]
    });

    const controller = new YeelightController(config, {
      log: () => {},
      // Small and fast so the test does not pay for the real blanking schedule.
      matrix: { poolSize: 2, fps: 10, blankAttempts: 1, blankSpacingMs: 20 }
    });

    try {
      await controller.start();
      controller.handleAgentStatus({
        paneKey: 'p1',
        state: 'working',
        worktreeId: 'r1::/w/alpha',
        receivedAt: Date.now()
      });
      await settle(1500);

      const direct = bulb.received.filter(
        (message) => message.method === 'activate_fx_mode' && message.params?.[0]?.mode === 'direct'
      );
      assert.ok(direct.length > 0, 'the panel must be put into direct mode');

      const frames = bulb.received.filter((message) => message.method === 'update_leds');
      assert.ok(frames.length >= 3, `expected a stream of frames, got ${frames.length}`);

      // Every frame is a full panel of three bytes per LED.
      for (const frame of frames) {
        assert.equal(Buffer.from(frame.params[0], 'base64').length, MATRIX_LEDS * 3);
      }

      // Frames must differ over time, or nothing is actually animating.
      const distinct = new Set(frames.map((frame) => frame.params[0]));
      assert.ok(distinct.size > 1, 'frames should change over time');

      // Once the loop owns the light, scenes must stop.
      const sceneAfterFirstFrame = bulb.received
        .slice(bulb.received.findIndex((message) => message.method === 'update_leds'))
        .filter((message) => message.method === 'set_scene');
      assert.deepEqual(sceneAfterFirstFrame, [], 'a driven panel must not also be sent scenes');
    } finally {
      await controller.stop();
      await bulb.close();
    }
  });

  /** Turning hearts off must hand the light back to the ordinary scene path. */
  it('releases the panel when hearts mode is switched off', async () => {
    const bulb = await startFakeBulb();

    const { YeelightController } = await import('../src/controller.mjs');
    const { normalizeConfig } = await import('../src/config.mjs');

    const { config } = normalizeConfig({
      autoDiscover: false,
      hearts: true,
      devices: [{ host: '127.0.0.1', port: bulb.port, name: 'panel' }]
    });

    const controller = new YeelightController(config, {
      log: () => {},
      matrix: { poolSize: 2, fps: 10, blankAttempts: 1, blankSpacingMs: 20 }
    });

    try {
      await controller.start();
      await settle(1200);
      assert.ok(bulb.received.some((message) => message.method === 'update_leds'), 'frames should start');

      controller.updateConfig({ ...controller.config, hearts: false });
      await settle(1200);
      const framesAtSwitch = bulb.received.filter((message) => message.method === 'update_leds').length;

      controller.handleAgentStatus({
        paneKey: 'p1',
        state: 'blocked',
        worktreeId: 'r1::/w/alpha',
        receivedAt: Date.now()
      });
      await settle(900);

      const framesNow = bulb.received.filter((message) => message.method === 'update_leds').length;
      assert.equal(framesNow, framesAtSwitch, 'the frame loop must stop');
      assert.ok(
        bulb.received.some((message) => message.method === 'set_scene'),
        'the light should be back on the ordinary scene path'
      );
    } finally {
      await controller.stop();
      await bulb.close();
    }
  });
});
