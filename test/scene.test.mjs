import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeConfig } from '../src/config.mjs';
import { AgentStatusTracker, DEFAULT_SCENES, resolveScene } from '../src/scene.mjs';

const T0 = 1_700_000_000_000;

describe('AgentStatusTracker', () => {
  it('reports idle with no agents', () => {
    assert.equal(new AgentStatusTracker().dominantStatus(T0), 'idle');
  });

  it('picks the most urgent status across panes', () => {
    const tracker = new AgentStatusTracker();
    tracker.update({ paneKey: 'a', state: 'working', receivedAt: T0 });
    tracker.update({ paneKey: 'b', state: 'done', receivedAt: T0 });
    assert.equal(tracker.dominantStatus(T0), 'working');

    tracker.update({ paneKey: 'c', state: 'waiting', receivedAt: T0 });
    assert.equal(tracker.dominantStatus(T0), 'waiting');

    tracker.update({ paneKey: 'd', state: 'blocked', receivedAt: T0 });
    assert.equal(tracker.dominantStatus(T0), 'blocked');
  });

  it('reuses a pane row rather than leaking one per event', () => {
    const tracker = new AgentStatusTracker();
    tracker.update({ paneKey: 'a', state: 'working', receivedAt: T0 });
    tracker.update({ paneKey: 'a', state: 'done', receivedAt: T0 + 10 });
    assert.equal(tracker.size, 1);
    assert.equal(tracker.dominantStatus(T0 + 10), 'done');
  });

  it('ignores unknown states and out-of-order events', () => {
    const tracker = new AgentStatusTracker();
    assert.equal(tracker.update({ paneKey: 'a', state: 'nonsense', receivedAt: T0 }), false);
    assert.equal(tracker.size, 0);

    tracker.update({ paneKey: 'a', state: 'blocked', receivedAt: T0 + 100 });
    tracker.update({ paneKey: 'a', state: 'working', receivedAt: T0 });
    assert.equal(tracker.dominantStatus(T0 + 100), 'blocked');
  });

  it('lets done decay to idle after the hold window', () => {
    const tracker = new AgentStatusTracker({ doneHoldMs: 60_000 });
    tracker.update({ paneKey: 'a', state: 'done', receivedAt: T0 });
    assert.equal(tracker.dominantStatus(T0 + 30_000), 'done');
    assert.equal(tracker.dominantStatus(T0 + 61_000), 'idle');
  });

  it('expires a pane that stopped reporting while working', () => {
    const tracker = new AgentStatusTracker({ staleAfterMs: 600_000 });
    tracker.update({ paneKey: 'a', state: 'working', receivedAt: T0 });
    assert.equal(tracker.dominantStatus(T0 + 599_000), 'working');
    assert.equal(tracker.dominantStatus(T0 + 601_000), 'idle');
  });

  it('drops panes when their worktree is removed', () => {
    const tracker = new AgentStatusTracker();
    tracker.update({ paneKey: 'a', state: 'blocked', worktreeId: 'wt-1', receivedAt: T0 });
    tracker.update({ paneKey: 'b', state: 'working', worktreeId: 'wt-2', receivedAt: T0 });
    assert.equal(tracker.removeWorktree('wt-1'), 1);
    assert.equal(tracker.dominantStatus(T0), 'working');
  });

  it('counts panes per status', () => {
    const tracker = new AgentStatusTracker();
    tracker.update({ paneKey: 'a', state: 'working', receivedAt: T0 });
    tracker.update({ paneKey: 'b', state: 'working', receivedAt: T0 });
    tracker.update({ paneKey: 'c', state: 'blocked', receivedAt: T0 });
    assert.deepEqual(tracker.countsByStatus(T0), { working: 2, blocked: 1 });
  });
});

describe('resolveScene', () => {
  it('turns the light off when idle', () => {
    assert.deepEqual(resolveScene('idle'), { status: 'idle', power: 'off' });
  });

  it('produces a solid scene for working', () => {
    const scene = resolveScene('working');
    assert.equal(scene.power, 'on');
    assert.equal(scene.color, DEFAULT_SCENES.working.color);
    assert.equal(scene.flow, undefined);
  });

  it('produces a repeating flow for breathing and pulsing statuses', () => {
    for (const status of ['waiting', 'blocked']) {
      const scene = resolveScene(status);
      assert.ok(scene.flow, `${status} should flow`);
      assert.equal(scene.flow.count, 0, 'flow must repeat forever');
      assert.ok(scene.flow.steps.length >= 2);
    }
  });

  it('scales brightness, including the flow floor', () => {
    const scene = resolveScene('waiting', DEFAULT_SCENES, { brightnessScale: 0.5 });
    assert.equal(scene.brightness, Math.round(DEFAULT_SCENES.waiting.brightness * 0.5));
    const low = Math.min(...scene.flow.steps.map((step) => step.brightness));
    assert.ok(low <= scene.brightness);
    assert.ok(low >= 1);
  });

  it('honours a user override', () => {
    const scenes = { ...DEFAULT_SCENES, working: { color: '#abcdef', brightness: 33, effect: 'solid' } };
    const scene = resolveScene('working', scenes);
    assert.equal(scene.color, '#abcdef');
    assert.equal(scene.brightness, 33);
  });

  it('rejects an unknown effect', () => {
    assert.throws(() => resolveScene('working', { working: { effect: 'strobe' } }), /unknown scene effect/);
  });
});

describe('normalizeConfig', () => {
  it('fills in defaults for an empty config', () => {
    const { config } = normalizeConfig({});
    assert.equal(config.enabled, true);
    assert.equal(config.autoDiscover, true);
    assert.deepEqual(config.devices, []);
    assert.equal(config.scenes.working.color, DEFAULT_SCENES.working.color);
  });

  it('tolerates a non-object root', () => {
    const { config, warnings } = normalizeConfig('nope');
    assert.equal(config.enabled, true);
    assert.ok(warnings.length > 0);
  });

  it('normalises device entries and drops hostless ones', () => {
    const { config, warnings } = normalizeConfig({
      devices: [{ host: ' 192.168.1.50 ', name: 'Cube' }, { port: 55443 }, '10.0.0.5']
    });
    assert.equal(config.devices.length, 2);
    assert.equal(config.devices[0].host, '192.168.1.50');
    assert.equal(config.devices[0].port, 55443);
    assert.equal(config.devices[1].host, '10.0.0.5');
    assert.ok(warnings.some((warning) => warning.includes('no host')));
  });

  it('falls back on a bad colour or effect and says why', () => {
    const { config, warnings } = normalizeConfig({
      scenes: { blocked: { color: 'not-a-colour', effect: 'strobe' } }
    });
    assert.equal(config.scenes.blocked.color, DEFAULT_SCENES.blocked.color);
    assert.equal(config.scenes.blocked.effect, DEFAULT_SCENES.blocked.effect);
    assert.equal(warnings.length, 2);
  });

  it('clamps out-of-range numbers', () => {
    const { config } = normalizeConfig({
      brightnessScale: 99,
      transitionMs: -5,
      scenes: { working: { brightness: 1000 } },
      timing: { doneHoldMs: 1 }
    });
    assert.equal(config.brightnessScale, 1);
    assert.equal(config.transitionMs, 30);
    assert.equal(config.scenes.working.brightness, 100);
    assert.equal(config.timing.doneHoldMs, 1000);
  });

  it('round-trips a config it produced', () => {
    const { config } = normalizeConfig({});
    const { config: again, warnings } = normalizeConfig(config);
    assert.deepEqual(again, config);
    assert.deepEqual(warnings, []);
  });
});
