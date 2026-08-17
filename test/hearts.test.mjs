import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeConfig } from '../src/config.mjs';
import { buildFlowExpression, toRgbInt } from '../src/protocol.mjs';
import {
  AgentStatusTracker,
  DEFAULT_SCENES,
  HEART_COUNT,
  MAX_FLOW_STEPS,
  heartStateFor,
  idleHearts,
  resolveHeartsScene
} from '../src/scene.mjs';

const T0 = 1_700_000_000_000;

/** The distinct colours a flow visits, in order, as rgb ints. */
function flowColors(scene) {
  return scene.flow.steps.map((step) => toRgbInt(step.color));
}

describe('heartStateFor', () => {
  it('folds the four agent states into the three a heart can show', () => {
    assert.equal(heartStateFor('working'), 'working');
    assert.equal(heartStateFor('waiting'), 'attention');
    assert.equal(heartStateFor('blocked'), 'attention');
    assert.equal(heartStateFor('done'), 'idle');
    assert.equal(heartStateFor(undefined), 'idle');
  });
});

describe('AgentStatusTracker#hearts', () => {
  it('always returns a full set, idle when nothing is running', () => {
    const hearts = new AgentStatusTracker().hearts(T0);
    assert.equal(hearts.length, HEART_COUNT);
    assert.deepEqual(
      hearts.map((heart) => heart.state),
      ['idle', 'idle', 'idle']
    );
    assert.deepEqual(
      hearts.map((heart) => heart.index),
      [0, 1, 2]
    );
  });

  it('gives one heart to each worktree and names it', () => {
    const tracker = new AgentStatusTracker();
    tracker.update({ paneKey: 'a', state: 'working', worktreeId: 'repo::/src/alpha', receivedAt: T0 });
    tracker.update({ paneKey: 'b', state: 'waiting', worktreeId: 'repo::/src/beta', receivedAt: T0 });

    const hearts = tracker.hearts(T0);
    assert.deepEqual(
      hearts.map((heart) => heart.state),
      ['attention', 'working', 'idle']
    );
    assert.equal(hearts[0].label, 'beta');
    assert.equal(hearts[1].label, 'alpha');
    assert.equal(hearts[2].key, null, 'the unclaimed slot belongs to no worktree');
  });

  it('collapses several agents in one worktree into a single heart', () => {
    const tracker = new AgentStatusTracker();
    for (const paneKey of ['a', 'b', 'c']) {
      tracker.update({ paneKey, state: 'working', worktreeId: 'repo::/src/alpha', receivedAt: T0 });
    }

    const hearts = tracker.hearts(T0);
    assert.deepEqual(
      hearts.map((heart) => heart.state),
      ['working', 'idle', 'idle'],
      'one worktree is one heart however many agents are in it'
    );
    assert.equal(hearts[0].panes, 3);
  });

  it('turns a whole worktree orange when any agent in it wants an answer', () => {
    const tracker = new AgentStatusTracker();
    tracker.update({ paneKey: 'a', state: 'working', worktreeId: 'repo::/src/alpha', receivedAt: T0 });
    tracker.update({ paneKey: 'b', state: 'blocked', worktreeId: 'repo::/src/alpha', receivedAt: T0 });

    assert.equal(tracker.hearts(T0)[0].state, 'attention');
  });

  it('leaves a slot idle rather than spending it on a finished worktree', () => {
    const tracker = new AgentStatusTracker();
    tracker.update({ paneKey: 'old', state: 'working', worktreeId: 'r::/w/live', receivedAt: T0 });
    // Three fresher worktrees that have all stopped doing anything.
    for (const paneKey of ['x', 'y', 'z']) {
      tracker.update({ paneKey, state: 'done', worktreeId: `r::/w/${paneKey}`, receivedAt: T0 + 1000 });
    }

    const hearts = tracker.hearts(T0 + 1000);
    assert.deepEqual(
      hearts.map((heart) => heart.state),
      ['working', 'idle', 'idle'],
      'finished worktrees must not crowd out a live one'
    );
    assert.equal(hearts[0].label, 'live');
  });

  it('keeps only the three most recent worktrees when more are live', () => {
    const tracker = new AgentStatusTracker();
    const names = ['one', 'two', 'three', 'four', 'five'];
    names.forEach((name, index) => {
      tracker.update({
        paneKey: `p-${name}`,
        state: 'working',
        worktreeId: `r::/w/${name}`,
        receivedAt: T0 + index * 1000
      });
    });

    const hearts = tracker.hearts(T0 + 5000);
    assert.deepEqual(
      hearts.map((heart) => heart.label),
      ['five', 'four', 'three'],
      'newest first, and only three fit'
    );
  });

  it('drops worktrees that went stale', () => {
    const tracker = new AgentStatusTracker({ staleAfterMs: 60_000 });
    tracker.update({ paneKey: 'a', state: 'working', worktreeId: 'r::/w/alpha', receivedAt: T0 });
    assert.equal(tracker.hearts(T0 + 61_000)[0].state, 'idle');
  });
});

describe('resolveHeartsScene', () => {
  const hearts = [
    { index: 0, state: 'working' },
    { index: 1, state: 'attention' },
    { index: 2, state: 'idle' }
  ];

  it('gives each light one heart when there are enough lights', () => {
    const scenes = [0, 1, 2].map((deviceIndex) =>
      resolveHeartsScene(hearts, DEFAULT_SCENES, { deviceIndex, deviceCount: 3 })
    );

    assert.deepEqual(
      scenes.map((scene) => scene.status),
      ['working', 'attention', 'idle']
    );
    assert.equal(scenes[0].color, DEFAULT_SCENES.working.color, 'working is blue');
    assert.equal(scenes[1].color, DEFAULT_SCENES.waiting.color, 'attention is yellow');

    // Both busy states pulse: two brightness levels on a single colour.
    for (const scene of scenes.slice(0, 2)) {
      assert.equal(new Set(flowColors(scene)).size, 1);
      assert.ok(new Set(scene.flow.steps.map((step) => step.brightness)).size > 1);
    }
    // The idle heart is a rainbow instead.
    assert.ok(new Set(flowColors(scenes[2])).size >= 4);
  });

  it('pulses attention faster than work, so the two never read alike', () => {
    const busy = resolveHeartsScene(hearts, DEFAULT_SCENES, { deviceIndex: 0, deviceCount: 3 });
    const wants = resolveHeartsScene(hearts, DEFAULT_SCENES, { deviceIndex: 1, deviceCount: 3 });
    const cycle = (scene) => scene.flow.steps.reduce((total, step) => total + step.duration, 0);
    assert.ok(cycle(wants) < cycle(busy));
  });

  it('wraps extra lights back onto the hearts', () => {
    const fourth = resolveHeartsScene(hearts, DEFAULT_SCENES, { deviceIndex: 3, deviceCount: 4 });
    const first = resolveHeartsScene(hearts, DEFAULT_SCENES, { deviceIndex: 0, deviceCount: 4 });
    assert.deepEqual(fourth.flow, first.flow);
  });

  it('spans one rainbow across the idle hearts instead of three copies', () => {
    const scenes = [0, 1, 2].map((deviceIndex) =>
      resolveHeartsScene(idleHearts(), DEFAULT_SCENES, { deviceIndex, deviceCount: 3 })
    );

    const starts = scenes.map((scene) => scene.color);
    assert.equal(new Set(starts).size, 3, 'each idle heart starts on its own hue');

    // Same sweep, a third of a turn apart: heart 1 starts where heart 0 is two
    // steps in (six hues, so 120 degrees is two of them).
    const [first, second] = scenes.map(flowColors);
    assert.equal(second[0], first[2]);
  });

  it('beats through every heart when there are fewer lights than hearts', () => {
    const scene = resolveHeartsScene(hearts, DEFAULT_SCENES, { deviceIndex: 0, deviceCount: 1 });
    const colors = flowColors(scene);

    assert.ok(colors.includes(toRgbInt(DEFAULT_SCENES.working.color)), 'working heart is shown');
    assert.ok(colors.includes(toRgbInt(DEFAULT_SCENES.waiting.color)), 'attention heart is shown');
    // Plus the rainbow heart's own hues.
    assert.ok(new Set(colors).size >= 6);

    // Each heart's turn opens with a 50 ms snap, so no colour fades into the
    // next heart's and invents a state that does not exist.
    assert.equal(scene.flow.steps[0].duration, 50);
    assert.ok(scene.flow.steps.length <= MAX_FLOW_STEPS);
  });

  it('stays inside the device flow limits in every arrangement', () => {
    const arrangements = [
      idleHearts(),
      hearts,
      [
        { index: 0, state: 'attention' },
        { index: 1, state: 'attention' },
        { index: 2, state: 'attention' }
      ],
      [
        { index: 0, state: 'working' },
        { index: 1, state: 'working' },
        { index: 2, state: 'working' }
      ]
    ];

    for (const set of arrangements) {
      for (const deviceCount of [1, 2, 3]) {
        for (let deviceIndex = 0; deviceIndex < deviceCount; deviceIndex += 1) {
          const scene = resolveHeartsScene(set, DEFAULT_SCENES, {
            deviceIndex,
            deviceCount,
            brightnessScale: 0.4
          });
          assert.equal(scene.power, 'on', 'hearts stay lit, even when all idle');
          assert.equal(scene.flow.count, 0, 'must repeat forever');
          assert.ok(scene.flow.steps.length <= MAX_FLOW_STEPS);

          for (const step of scene.flow.steps) {
            assert.ok(step.duration >= 50, 'the firmware rejects steps under 50ms');
            assert.ok(step.brightness >= 1 && step.brightness <= 100);
          }
          assert.doesNotThrow(() => buildFlowExpression(scene.flow.steps));
        }
      }
    }
  });

  it('follows a user palette but not a user effect', () => {
    const scenes = {
      ...DEFAULT_SCENES,
      working: { ...DEFAULT_SCENES.working, color: '#abcdef', effect: 'solid' }
    };
    const scene = resolveHeartsScene(hearts, scenes, { deviceIndex: 0, deviceCount: 3 });
    assert.equal(scene.color, '#abcdef');
    assert.ok(scene.flow, 'a heart pulses regardless of the scene effect');
  });

  it('falls back to a full idle set when handed nothing', () => {
    assert.equal(resolveHeartsScene([], DEFAULT_SCENES).hearts, HEART_COUNT);
  });
});

describe('hearts config', () => {
  it('is off unless explicitly enabled', () => {
    assert.equal(normalizeConfig({}).config.hearts, false);
    assert.equal(normalizeConfig({ hearts: 'yes' }).config.hearts, false);
    assert.equal(normalizeConfig({ hearts: true }).config.hearts, true);
  });
});
