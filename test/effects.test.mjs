import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeConfig } from '../src/config.mjs';
import { buildFlowExpression, hsvToHex, rainbowPalette, toRgbInt } from '../src/protocol.mjs';
import {
  AgentStatusTracker,
  DEFAULT_SCENES,
  EFFECTS,
  MAX_FLOW_STEPS,
  parseWorktreeId,
  resolveProjectCycleScene,
  resolveScene
} from '../src/scene.mjs';

const T0 = 1_700_000_000_000;

/** Every effect is realisable as a flow the device will accept. */
describe('effects', () => {
  const flowEffects = EFFECTS.filter((effect) => effect !== 'solid' && effect !== 'off');

  for (const effect of flowEffects) {
    it(`${effect} produces a bounded, repeating, encodable flow`, () => {
      const scene = resolveScene('working', {
        working: { color: '#1e6bff', colors: ['#ff0000', '#00ff00'], brightness: 80, effect, periodMs: 1200 }
      });

      assert.ok(scene.flow, `${effect} should produce a flow`);
      assert.equal(scene.flow.count, 0, 'must repeat forever');
      assert.ok(scene.flow.steps.length >= 2, 'needs at least two steps');
      assert.ok(
        scene.flow.steps.length <= MAX_FLOW_STEPS,
        `${effect} exceeded the ${MAX_FLOW_STEPS}-step cap`
      );

      // Every tuple must satisfy the firmware's constraints.
      const expression = buildFlowExpression(scene.flow.steps);
      for (const tuple of expression.split(',').reduce((acc, value, index) => {
        if (index % 4 === 0) acc.push([]);
        acc.at(-1).push(Number(value));
        return acc;
      }, [])) {
        const [duration, mode, value, brightness] = tuple;
        assert.ok(duration >= 50, `${effect}: duration ${duration} below the 50ms minimum`);
        assert.equal(mode, 1, `${effect}: expected colour mode`);
        assert.ok(value >= 1 && value <= 0xffffff, `${effect}: rgb ${value} out of range`);
        assert.ok(brightness >= 1 && brightness <= 100, `${effect}: brightness ${brightness} out of range`);
      }
    });
  }

  it('alternate snaps between colours instead of fading', () => {
    const scene = resolveScene('working', {
      working: { colors: ['#ff0000', '#0000ff'], brightness: 90, effect: 'alternate', periodMs: 2000 }
    });
    // A snap is a 50ms transition followed by a hold at the same colour.
    assert.equal(scene.flow.steps[0].duration, 50);
    assert.equal(scene.flow.steps[0].color, scene.flow.steps[1].color);
    assert.ok(scene.flow.steps[1].duration > 50);
    assert.notEqual(scene.flow.steps[0].color, scene.flow.steps[2].color);
  });

  it('cycle fades smoothly through the whole palette', () => {
    const colors = ['#ff0000', '#00ff00', '#0000ff'];
    const scene = resolveScene('working', { working: { colors, brightness: 70, effect: 'cycle' } });
    assert.deepEqual(
      scene.flow.steps.map((step) => step.color),
      colors
    );
    assert.ok(scene.flow.steps.every((step) => step.duration > 50));
  });

  it('rainbow synthesises its own palette', () => {
    const scene = resolveScene('done', { done: { effect: 'rainbow', brightness: 80 } });
    const colors = scene.flow.steps.map((step) => step.color);
    assert.equal(new Set(colors).size, colors.length, 'hues must be distinct');
    assert.equal(colors.length, 6);
  });

  it('strobe drops to the minimum the device accepts, never zero', () => {
    const scene = resolveScene('blocked', {
      blocked: { color: '#ff0000', brightness: 100, effect: 'strobe', periodMs: 600 }
    });
    const low = Math.min(...scene.flow.steps.map((step) => step.brightness));
    assert.equal(low, 1);
  });

  it('caps an oversized palette rather than overflowing the device', () => {
    const scene = resolveScene('working', {
      working: {
        effect: 'alternate',
        brightness: 50,
        colors: Array.from({ length: 20 }, (_, i) => hsvToHex(i * 18))
      }
    });
    assert.ok(scene.flow.steps.length <= MAX_FLOW_STEPS);
  });
});

describe('hsvToHex / rainbowPalette', () => {
  it('maps the primary hues', () => {
    assert.equal(toRgbInt(hsvToHex(0)), 0xff0000);
    assert.equal(toRgbInt(hsvToHex(120)), 0x00ff00);
    assert.equal(toRgbInt(hsvToHex(240)), 0x0000ff);
  });

  it('wraps negative and oversized hues', () => {
    assert.equal(hsvToHex(-120), hsvToHex(240));
    assert.equal(hsvToHex(480), hsvToHex(120));
  });

  it('produces distinct, bounded palettes', () => {
    const palette = rainbowPalette(6);
    assert.equal(palette.length, 6);
    assert.equal(new Set(palette).size, 6);
    assert.equal(rainbowPalette(99).length, 8, 'palette is capped');
    assert.equal(rainbowPalette(1).length, 2, 'palette has a floor');
  });
});

describe('parseWorktreeId', () => {
  it('splits Orca\'s <repoId>::<path> form and names the project', () => {
    const parsed = parseWorktreeId('37c9c8a2::/Users/me/orca/workspaces/Playground/yeelight-orca');
    assert.equal(parsed.repoId, '37c9c8a2');
    assert.equal(parsed.path, '/Users/me/orca/workspaces/Playground/yeelight-orca');
    assert.equal(parsed.label, 'yeelight-orca');
  });

  it('degrades gracefully on an unfamiliar id', () => {
    assert.equal(parseWorktreeId('opaque-id').label, 'opaque-id');
    assert.equal(parseWorktreeId(null).label, 'unassigned');
  });
});

describe('multiple projects', () => {
  const tracker = () => {
    const t = new AgentStatusTracker();
    t.update({ paneKey: 'a', state: 'working', worktreeId: 'r1::/w/alpha', receivedAt: T0 });
    t.update({ paneKey: 'b', state: 'working', worktreeId: 'r1::/w/alpha', receivedAt: T0 });
    t.update({ paneKey: 'c', state: 'blocked', worktreeId: 'r2::/w/beta', receivedAt: T0 });
    t.update({ paneKey: 'd', state: 'waiting', worktreeId: 'r3::/w/gamma', receivedAt: T0 });
    return t;
  };

  it('reports one status per project, most urgent first', () => {
    const projects = tracker().projects(T0);
    assert.deepEqual(
      projects.map((project) => [project.label, project.status]),
      [
        ['beta', 'blocked'],
        ['gamma', 'waiting'],
        ['alpha', 'working']
      ]
    );
    assert.equal(projects.find((p) => p.label === 'alpha').panes, 2);
  });

  it('can group by repo instead of worktree', () => {
    const t = new AgentStatusTracker();
    t.update({ paneKey: 'a', state: 'working', worktreeId: 'r1::/w/one', receivedAt: T0 });
    t.update({ paneKey: 'b', state: 'blocked', worktreeId: 'r1::/w/two', receivedAt: T0 });
    assert.equal(t.projects(T0, { groupBy: 'worktree' }).length, 2);

    const byRepo = t.projects(T0, { groupBy: 'repo' });
    assert.equal(byRepo.length, 1);
    assert.equal(byRepo[0].status, 'blocked', 'the repo takes its most urgent worktree');
  });

  it('cycles one colour per running project', () => {
    const scene = resolveProjectCycleScene(tracker().projects(T0));
    assert.ok(scene.flow, 'several projects must produce a cycle');
    assert.equal(scene.projects, 3);

    const colors = [...new Set(scene.flow.steps.map((step) => step.color))];
    assert.deepEqual(colors, [
      DEFAULT_SCENES.blocked.color,
      DEFAULT_SCENES.waiting.color,
      DEFAULT_SCENES.working.color
    ]);
  });

  it('collapses to a plain scene with one project, and to idle with none', () => {
    const one = new AgentStatusTracker();
    one.update({ paneKey: 'a', state: 'working', worktreeId: 'r1::/w/solo', receivedAt: T0 });
    const single = resolveProjectCycleScene(one.projects(T0));
    // It must be the plain single-status scene, not a multi-project cycle.
    assert.deepEqual(single, resolveScene('working'));
    assert.equal(single.projects, undefined, 'a single project should not cycle');

    assert.deepEqual(resolveProjectCycleScene([]), { status: 'idle', power: 'off' });
  });

  it('stays inside the step cap with many projects', () => {
    const many = new AgentStatusTracker();
    for (let i = 0; i < 12; i++) {
      many.update({ paneKey: `p${i}`, state: 'working', worktreeId: `r${i}::/w/p${i}`, receivedAt: T0 });
    }
    const scene = resolveProjectCycleScene(many.projects(T0));
    assert.ok(scene.flow.steps.length <= MAX_FLOW_STEPS);
  });
});

describe('config for effects and projects', () => {
  it('defaults to cycling across projects', () => {
    const { config } = normalizeConfig({});
    assert.equal(config.multiProject, 'cycle');
    assert.equal(config.groupBy, 'worktree');
    assert.deepEqual(config.assignments, []);
  });

  it('accepts the new effects', () => {
    const { config, warnings } = normalizeConfig({
      scenes: { done: { effect: 'rainbow' }, blocked: { effect: 'strobe' } }
    });
    assert.equal(config.scenes.done.effect, 'rainbow');
    assert.equal(config.scenes.blocked.effect, 'strobe');
    assert.deepEqual(warnings, []);
  });

  it('keeps a valid palette and drops junk entries', () => {
    const { config, warnings } = normalizeConfig({
      scenes: { working: { effect: 'cycle', colors: ['#ff0000', 'nope', '#00ff00'] } }
    });
    assert.deepEqual(config.scenes.working.colors, ['#ff0000', '#00ff00']);
    assert.ok(warnings.some((warning) => warning.includes('colors')));
  });

  it('validates assignments and rejects incomplete ones', () => {
    const { config, warnings } = normalizeConfig({
      assignments: [{ match: 'alpha', device: '192.168.1.50' }, { match: 'beta' }]
    });
    assert.deepEqual(config.assignments, [{ match: 'alpha', device: '192.168.1.50' }]);
    assert.ok(warnings.some((warning) => warning.includes('assignments[1]')));
  });

  it('falls back on an unknown multiProject mode', () => {
    const { config, warnings } = normalizeConfig({ multiProject: 'disco', groupBy: 'galaxy' });
    assert.equal(config.multiProject, 'cycle');
    assert.equal(config.groupBy, 'worktree');
    assert.equal(warnings.length, 2);
  });
});
