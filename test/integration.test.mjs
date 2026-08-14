/**
 * End-to-end test of the plugin entry point.
 *
 * Drives `activate` through the exact contract Orca's plugin worker provides
 * (`commands.register`, `events.on`, `host.call`) against a fake bulb that
 * speaks the real wire protocol, so the assertions are on the bytes a device
 * would actually receive.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { decodeMessages, toRgbInt } from '../src/protocol.mjs';
import { DEFAULT_SCENES } from '../src/scene.mjs';

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

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yeelight-orca-'));
    configPath = path.join(dir, 'yeelight.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        enabled: true,
        autoDiscover: false,
        devices: [{ host: '127.0.0.1', port: bulb.port, name: 'Fake bulb' }]
      })
    );
    process.env.ORCA_YEELIGHT_CONFIG = configPath;

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
    assert.equal(scene.params[0], 'color');
    assert.equal(scene.params[1], toRgbInt(DEFAULT_SCENES.working.color));
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
    assert.equal(scene.params[0], 'color');
    assert.equal(scene.params[1], toRgbInt(DEFAULT_SCENES.working.color));
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
