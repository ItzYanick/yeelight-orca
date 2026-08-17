/**
 * Orca plugin entry point.
 *
 * Runs in Orca's out-of-process plugin worker: a forked Node process that
 * receives host events over IPC and calls back through the capability-gated
 * host API. Everything network-facing lives here rather than in the panel,
 * because plugin panels are sandboxed with `connect-src 'none'`.
 */

import { loadConfig, watchConfig, CONFIG_PATH } from './config.mjs';
import { YeelightController } from './controller.mjs';
import { resolveScene, STATUS_PRIORITY } from './scene.mjs';

const STORAGE_KEY_DEVICES = 'known-devices';
const DISCOVERY_NOTIFY_TITLE = 'Yeelight';

/** What each heart looks like, in the words the legend uses. */
const HEART_COLOURS = { working: 'blue', attention: 'yellow', idle: 'rainbow' };

/** Human-readable one-liner for the status notification. */
function describeSummary(summary) {
  const connected = summary.devices.filter((device) => device.connected).length;
  const lights = `${connected}/${summary.devices.length} light${
    summary.devices.length === 1 ? '' : 's'
  } connected`;

  const agents = STATUS_PRIORITY.filter((status) => summary.counts[status])
    .map((status) => `${summary.counts[status]} ${status}`)
    .join(', ');

  const hearts = summary.hearts
    ? ` — hearts ${summary.hearts.map((heart) => HEART_COLOURS[heart.state] ?? heart.state).join('/')}`
    : '';

  const sync = summary.enabled ? summary.status : 'sync off';
  return `${sync} — ${lights}${agents ? ` — ${agents}` : ''}${hearts}`;
}

export default async function activate(context) {
  const { commands, events, host, grantedCapabilities, log } = context;
  const granted = new Set((grantedCapabilities ?? []).map((entry) => entry.kind ?? entry));
  const can = (capability) => granted.size === 0 || granted.has(capability);

  /** Host calls are advisory: a denied capability must not break the sync. */
  const callHost = async (method, params) => {
    try {
      return await host.call(method, params);
    } catch (error) {
      log(`host call ${method} failed: ${error.message}`);
      return null;
    }
  };

  const notify = async (body, title = DISCOVERY_NOTIFY_TITLE) => {
    if (!can('notifications:show')) return;
    await callHost('notifications.show', { title, body: body.slice(0, 1000) });
  };

  const config = await loadConfig({ log });
  log(`config loaded from ${CONFIG_PATH}`);

  const controller = new YeelightController(config, {
    log,
    onStatusChange: (summary) => {
      // Persist reachable devices so the next start can light up before the
      // first LAN scan finishes — and keep working if multicast is blocked.
      if (!can('storage')) return;
      const known = controller.devices.map((device) => ({
        id: device.id,
        host: device.host,
        port: device.port,
        name: device.name,
        model: device.model,
        support: device.support
      }));
      void callHost('storage.set', { key: STORAGE_KEY_DEVICES, value: known });
      void summary;
    }
  });

  // Seed from the last known devices before scanning, so a restart is instant.
  if (can('storage')) {
    const stored = await callHost('storage.get', { key: STORAGE_KEY_DEVICES });
    const cached = Array.isArray(stored?.value) ? stored.value : [];
    if (cached.length > 0) {
      log(`restoring ${cached.length} cached device(s)`);
      controller.updateConfig({ ...controller.config, devices: [...config.devices, ...cached] });
    }
  }

  await controller.start();

  // ---------------------------------------------------------------- events

  events.on('agent.status.changed', (payload) => {
    controller.handleAgentStatus({
      paneKey: payload.paneKey,
      state: payload.state,
      worktreeId: payload.worktreeId ?? null,
      receivedAt: payload.receivedAt ?? Date.now()
    });
  });

  events.on('worktree.removed', (payload) => {
    controller.handleWorktreeRemoved(payload.worktreeId);
  });

  // The manifest declares these statically; subscribing again is idempotent
  // and keeps the plugin working if it is ever loaded without the manifest
  // subscription being honoured.
  if (can('events:subscribe')) {
    await callHost('events.subscribe', {
      events: ['agent.status.changed', 'worktree.removed']
    });
  }

  // -------------------------------------------------------------- commands

  commands.register('yeelight.discover', async () => {
    const found = await controller.discover();
    const message =
      found.length === 0
        ? 'No lights answered. Turn on "LAN Control" in the Yeelight app, or add the IP to ~/.orca/yeelight.json.'
        : `Found ${found.length} light${found.length === 1 ? '' : 's'}: ${found
            .map((device) => device.name || device.host)
            .join(', ')}`;
    log(message);
    await notify(message);
    return { found: found.length };
  });

  commands.register('yeelight.toggle', async () => {
    const next = !controller.config.enabled;
    controller.updateConfig({ ...controller.config, enabled: next });
    await persistEnabled(next, log);
    await notify(next ? 'Status sync enabled.' : 'Status sync disabled.');
    return { enabled: next };
  });

  commands.register('yeelight.status', async () => {
    const summary = controller.summary();
    const message = describeSummary(summary);
    log(message);
    await notify(message);
    return summary;
  });

  commands.register('yeelight.off', async () => {
    controller.applyScene({ status: 'idle', power: 'off' });
    return { ok: true };
  });

  commands.register('yeelight.test', async () => {
    // Walks the full palette so a new user can confirm the mapping at a glance.
    for (const status of [...STATUS_PRIORITY, 'idle']) {
      controller.applyScene(
        resolveScene(status, controller.config.scenes, {
          brightnessScale: controller.config.brightnessScale
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
    controller.refresh();
    return { ok: true };
  });

  // ---------------------------------------------------------------- config

  const stopWatching = watchConfig({
    log,
    onChange: (next) => {
      log('config changed; reloading');
      controller.updateConfig(next);
    }
  });

  // Awaited so panels get blanked before their sockets close; a panel left
  // holding its last frame reads as a crash rather than a clean shutdown.
  context.__teardown = async () => {
    stopWatching();
    await controller.stop();
  };

  globalThis.__orcaYeelightTeardown = context.__teardown;
  log('yeelight sync active');
}

/** Writes the toggle back to the config file so it survives a restart. */
async function persistEnabled(enabled, log) {
  try {
    const fs = await import('node:fs/promises');
    const raw = await fs.readFile(CONFIG_PATH, 'utf8').catch(() => '{}');
    const parsed = JSON.parse(raw);
    parsed.enabled = enabled;
    await fs.writeFile(CONFIG_PATH, `${JSON.stringify(parsed, null, 2)}\n`);
  } catch (error) {
    log(`could not persist enabled flag: ${error.message}`);
  }
}

export function deactivate() {
  globalThis.__orcaYeelightTeardown?.();
}
