#!/usr/bin/env node
/**
 * Standalone CLI for the same engine the Orca plugin runs.
 *
 * Exists so the lights can be proven working (or a network problem diagnosed)
 * without installing the plugin or restarting Orca — the plugin worker's logs
 * are otherwise the only feedback channel.
 *
 *   node bin/orca-yeelight.mjs discover
 *   node bin/orca-yeelight.mjs scene blocked
 *   node bin/orca-yeelight.mjs demo
 *   node bin/orca-yeelight.mjs props
 *   node bin/orca-yeelight.mjs off
 */

import process from 'node:process';

import { loadConfig } from '../src/config.mjs';
import { YeelightController } from '../src/controller.mjs';
import { discoverDevices } from '../src/discovery.mjs';
import {
  EFFECTS,
  resolveProjectCycleScene,
  resolveScene,
  STATUS_PRIORITY
} from '../src/scene.mjs';

const USAGE = `orca-yeelight — drive Yeelight lights with the Orca status palette

Usage:
  orca-yeelight discover            Scan the LAN and list every light found
  orca-yeelight scene <status>      Apply one status colour
                                    (${[...STATUS_PRIORITY, 'idle'].join(' | ')})
  orca-yeelight demo                Cycle through every status colour
  orca-yeelight effect <name> [hex] Preview one effect
                                    (${EFFECTS.join(' | ')})
  orca-yeelight projects [n]        Preview the multi-project cycle with n projects
  orca-yeelight hearts              Preview hearts mode: busy, waiting, then all idle
  orca-yeelight props               Print live properties of each light
  orca-yeelight off                 Turn every light off
  orca-yeelight --help

Configuration is read from ~/.orca/yeelight.json, the same file the plugin uses.
`;

const log = (message) => console.log(message);

function formatDevice(device) {
  const name = device.name || '(unnamed)';
  return `  ${device.host.padEnd(15)}  ${String(device.model).padEnd(14)}  ${name}`;
}

async function withController(fn, { discover = true } = {}) {
  const config = await loadConfig({ log: (message) => console.error(`[config] ${message}`) });
  const controller = new YeelightController(
    { ...config, autoDiscover: discover && config.autoDiscover },
    { log: (message) => console.error(`[yeelight] ${message}`) }
  );
  await controller.start();

  if (controller.devices.length === 0) {
    console.error(
      '\nNo lights reachable.\n' +
        '  • Enable "LAN Control" for each light in the Yeelight app.\n' +
        '  • Make sure this machine is on the same subnet (guest Wi-Fi will not work).\n' +
        '  • If multicast is blocked, add the IPs to "devices" in ~/.orca/yeelight.json.\n'
    );
    controller.stop();
    process.exitCode = 1;
    return;
  }

  try {
    await fn(controller);
  } finally {
    // Give the coalesced writes time to reach the wire before tearing down.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    controller.stop();
  }
}

async function main(argv) {
  const [command = 'discover', ...rest] = argv;

  if (command === '--help' || command === '-h' || command === 'help') {
    log(USAGE);
    return;
  }

  if (command === 'discover') {
    log('Scanning for Yeelight devices…\n');
    const found = await discoverDevices({ log: (message) => console.error(`[scan] ${message}`) });
    if (found.length === 0) {
      console.error(
        'No devices answered.\n' +
          '  • "LAN Control" must be enabled per light in the Yeelight app.\n' +
          '  • macOS will ask Orca (or your terminal) for Local Network access — allow it.\n' +
          '  • Some routers block multicast between clients; pin IPs in the config instead.'
      );
      process.exitCode = 1;
      return;
    }
    log(`Found ${found.length} device(s):\n`);
    log('  IP               MODEL           NAME');
    for (const device of found) log(formatDevice(device));
    log('\nAdd any of these to ~/.orca/yeelight.json to pin them.');
    return;
  }

  if (command === 'scene') {
    const status = rest[0];
    if (!status || ![...STATUS_PRIORITY, 'idle'].includes(status)) {
      console.error(`Unknown status "${status ?? ''}".\n${USAGE}`);
      process.exitCode = 1;
      return;
    }
    await withController(async (controller) => {
      controller.applyScene(
        resolveScene(status, controller.config.scenes, {
          brightnessScale: controller.config.brightnessScale
        })
      );
      log(`Applied "${status}" to ${controller.devices.length} light(s).`);
    });
    return;
  }

  if (command === 'demo') {
    await withController(async (controller) => {
      for (const status of [...STATUS_PRIORITY, 'idle']) {
        log(`→ ${status}`);
        controller.applyScene(
          resolveScene(status, controller.config.scenes, {
            brightnessScale: controller.config.brightnessScale
          })
        );
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    });
    return;
  }

  if (command === 'effect') {
    const [name, color = '#1e6bff'] = rest;
    if (!name || !EFFECTS.includes(name)) {
      console.error(`Unknown effect "${name ?? ''}".\n${USAGE}`);
      process.exitCode = 1;
      return;
    }
    await withController(async (controller) => {
      // A synthetic single-status palette so any effect can be previewed.
      const scene = resolveScene('preview', {
        preview: { color, brightness: 90, effect: name, periodMs: 1600, minBrightness: 15 }
      });
      controller.applyScene(scene);
      log(`Previewing "${name}" in ${color}. Ctrl-C when you have seen enough.`);
      await new Promise((resolve) => setTimeout(resolve, 12_000));
    });
    return;
  }

  if (command === 'projects') {
    const count = Math.min(4, Math.max(2, Number.parseInt(rest[0] ?? '3', 10) || 3));
    await withController(async (controller) => {
      // Fabricate one project per status so the cycle is visible without
      // needing that many agents actually running.
      const projects = STATUS_PRIORITY.slice(0, count).map((status, index) => ({
        key: `demo-${index}`,
        label: `project-${index + 1}`,
        status,
        panes: 1
      }));
      log(`Cycling ${count} projects: ${projects.map((p) => p.status).join(' -> ')}`);
      controller.applyScene(
        resolveProjectCycleScene(projects, controller.config.scenes, {
          brightnessScale: controller.config.brightnessScale,
          periodMs: controller.config.projectCycleMs
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 15_000));
    });
    return;
  }

  if (command === 'hearts') {
    await withController(async (controller) => {
      // Drive the real path — config, tracker, per-light heart slots — with
      // fabricated agents, so the preview is the thing itself and not a mock.
      controller.updateConfig({
        ...controller.config,
        enabled: true,
        hearts: true,
        assignments: []
      });

      const now = Date.now();
      const demo = [
        { paneKey: 'demo-1', state: 'working', worktreeId: 'demo::/tmp/alpha' },
        { paneKey: 'demo-2', state: 'waiting', worktreeId: 'demo::/tmp/beta' }
      ];
      for (const [index, pane] of demo.entries()) {
        controller.handleAgentStatus({ ...pane, receivedAt: now - index });
      }

      const lights = controller.devices.length;
      log(
        lights >= 3
          ? `Three hearts across ${lights} lights: blue (working), yellow (waiting), rainbow (idle).`
          : `Fewer lights (${lights}) than hearts, so each light beats through all three: ` +
            'blue (working), yellow (waiting), rainbow (idle).'
      );
      await new Promise((resolve) => setTimeout(resolve, 12_000));

      log('All idle: three rainbow hearts, a third of the hue wheel apart.');
      controller.tracker.clear();
      controller.refresh();
      await new Promise((resolve) => setTimeout(resolve, 15_000));
    });
    return;
  }

  if (command === 'props') {
    await withController(async (controller) => {
      for (const device of controller.devices) {
        try {
          const props = await device.getProperties();
          log(`${device.label}: ${JSON.stringify(props)}`);
        } catch (error) {
          if (error.code === 'GET_PROP_UNSUPPORTED') {
            // Writes still work on these models, so this is not a failure.
            log(`${device.label}: connected, but this model cannot report properties`);
          } else {
            log(`${device.label}: unreachable (${error.message})`);
          }
        }
      }
    });
    return;
  }

  if (command === 'off') {
    await withController(async (controller) => {
      controller.applyScene({ status: 'idle', power: 'off' });
      log(`Turned off ${controller.devices.length} light(s).`);
    });
    return;
  }

  console.error(`Unknown command "${command}".\n\n${USAGE}`);
  process.exitCode = 1;
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
});
