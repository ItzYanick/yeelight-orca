# Yeelight Status Sync for Orca

An Orca plugin that turns your Yeelight smart lights into an ambient status
display for your coding agents.

| Light | Agent status | Meaning |
| --- | --- | --- |
| 🔴 red, pulsing | `blocked` | an agent is stuck and needs you |
| 🟠 amber, breathing | `waiting` | an agent is asking a question |
| 🔵 blue, breathing slowly | `working` | an agent is running |
| 🟢 green, steady | `done` | finished in the last 90 seconds |
| ⚫ off | idle | nothing is running |

With several agents going at once the light shows the most urgent one, so a
single glance across the room tells you whether anything wants your attention.

## Tested hardware

Verified end to end against a **Yeelight Cube Lite** (firmware 1.0.0) on the LAN:
discovery, connection, and all five scenes drive the light correctly.

Two quirks of that model, both handled:

- It advertises an **empty `support` list**, so capabilities cannot be
  feature-detected. The plugin assumes the modern command set in that case —
  confirmed correct here: `set_scene`, `start_cf`, `stop_cf`, `set_rgb`,
  `set_bright`, and `set_power` all work.
- It **does not implement `get_prop`** — it accepts every write but never
  answers a query, with neither a result nor an error. Only the CLI's `props`
  command reads properties, and it reports this distinctly instead of claiming
  the light is unreachable. The status sync never queries, so it is unaffected.

**This model has no readable state at all.** `get_prop` times out, the SSDP
advert is frozen (it reports `rgb=16777215` and `power=on` no matter what the
light is actually doing), and it sends no unsolicited notifications. Colour
flows do work, including brightness-only ones. If you are debugging one of
these, budget for the fact that the only way to observe it is to look at it.

## Requirements

- Orca 1.4.0 or newer, with the plugin system enabled in Settings.
- One or more Wi-Fi Yeelight devices with **LAN Control** switched on.
- The lights and your Mac on the same subnet (a guest network will not work).

Nothing to install — the plugin uses only Node's standard library.

## Enabling LAN Control

This is the step people miss: Yeelight's local API is off by default.

1. Open the **Yeelight** app.
2. Tap a light → the ⋯ / settings icon.
3. Enable **LAN Control** (sometimes listed as "Developer Mode").
4. Repeat for each light.

## Installing the plugin

1. Orca → **Settings → Plugins → Install**.
2. Choose the **Local folder** tab.
3. Paste the full path to this repository.
4. Review the consent dialog and enable the plugin.

The plugin requests three capabilities:

| Capability | Why |
| --- | --- |
| `events:subscribe` | receive `agent.status.changed` and `worktree.removed` |
| `notifications:show` | report discovery results and sync status |
| `storage` | remember which lights were reachable, so a restart lights up instantly |

It never asks for `terminal:send`, `secrets`, or `workspace:read`.

## Using it

Once enabled the sync runs on its own. From the command palette:

| Command | What it does |
| --- | --- |
| `Yeelight: Discover Lights` | rescan the LAN and adopt anything new |
| `Yeelight: Show Sync Status` | notification with live state and connections |
| `Yeelight: Test Colour Mapping` | walk every colour so you can learn the palette |
| `Yeelight: Toggle Status Sync` | pause without uninstalling |
| `Yeelight: Turn Lights Off` | immediate blackout |

There is also a **Yeelight** panel in the right sidebar with the colour legend
and setup notes.

## Configuration

Everything lives in `~/.orca/yeelight.json`, created with defaults on first run.
Saving the file reloads it immediately — no restart, no reinstall.

```jsonc
{
  "enabled": true,
  "autoDiscover": true,

  // Pin lights here when multicast discovery does not work.
  "devices": [{ "host": "192.168.1.50", "name": "Desk cube" }],

  "brightnessScale": 1,      // 0.4 for a dark room
  "transitionMs": 400,

  "multiProject": "cycle",   // see "Multiple projects" below
  "projectCycleMs": 1400,
  "groupBy": "worktree",
  "assignments": [],

  "scenes": {
    "blocked": { "color": "#ff1a1a", "brightness": 100, "effect": "pulse",   "periodMs": 900,  "minBrightness": 20 },
    "waiting": { "color": "#ffa000", "brightness": 90,  "effect": "breathe", "periodMs": 2600, "minBrightness": 25 },
    "working": { "color": "#1e6bff", "brightness": 70,  "effect": "solid" },
    "done":    { "color": "#12c46a", "brightness": 80,  "effect": "solid" },
    "idle":    { "effect": "off" }
  },

  "timing": {
    "doneHoldMs": 90000,     // how long green lingers after a finish
    "staleAfterMs": 1800000  // forget a pane that stops reporting
  }
}
```

### Effects

| Effect | Looks like |
| --- | --- |
| `solid` | steady colour |
| `breathe` | smooth fade up and down |
| `pulse` | snap bright, slow decay — more urgent than a breath |
| `strobe` | hard on/off flashing |
| `alternate` | snaps between the colours in `colors` |
| `cycle` | smooth fade through `colors` |
| `rainbow` | fades through a generated hue wheel |
| `candle` | irregular flicker |
| `off` | light off |

Multi-colour effects read the scene's `colors` array (up to 8); the others use
`color`. A malformed field falls back to its default and logs a warning rather
than breaking the sync.

```jsonc
"done": { "effect": "rainbow", "brightness": 80 },
"waiting": { "effect": "alternate", "colors": ["#ffa000", "#ff4400"], "periodMs": 1200 }
```

Every effect runs as an on-device colour flow: one command sets it up, then the
light animates on its own with no further network traffic.

## Multiple projects

When agents are running in more than one worktree, a single light can still show
all of them — it steps through one colour per project, so three colours means
three projects.

```jsonc
"multiProject": "cycle",     // "cycle" (default) or "priority"
"projectCycleMs": 1400,      // how long each project's colour is held
"groupBy": "worktree",       // or "repo", to merge a repo's worktrees
```

`priority` restores the simpler behaviour: only the single most urgent status is
shown. With one project running the two modes are identical.

With several lights, bind one to a project so it ignores everything else:

```jsonc
"assignments": [
  { "match": "yeelight-orca", "device": "192.168.1.50" },
  { "match": "api-server",    "device": "Desk cube" }
]
```

`match` is matched against the worktree name or path; `device` against a light's
IP, name, or id. Unassigned lights keep showing the global picture.

Want the light to dim instead of switching off when idle? Set
`"idle": { "effect": "solid", "color": "#101010", "brightness": 1 }`.

## Command-line tool

The same engine runs standalone, which is the fastest way to prove the lights
work before involving Orca:

```bash
node bin/orca-yeelight.mjs discover      # scan and list every light
node bin/orca-yeelight.mjs scene blocked # apply one status colour
node bin/orca-yeelight.mjs demo          # cycle the whole palette
node bin/orca-yeelight.mjs effect rainbow    # preview one effect
node bin/orca-yeelight.mjs effect pulse '#ff0000'
node bin/orca-yeelight.mjs projects 3        # preview the multi-project cycle
node bin/orca-yeelight.mjs props         # read live device properties
node bin/orca-yeelight.mjs off
```

## Troubleshooting

**Discovery finds nothing.** In order of likelihood: LAN Control is still off in
the Yeelight app; macOS has not been granted Local Network access for Orca
(System Settings → Privacy & Security → Local Network); the light is on a
different subnet or the 2.4 GHz guest SSID; or the router blocks multicast
between clients. The last case is common on mesh routers — put the IPs in
`devices` and discovery is bypassed entirely.

**Lights lag behind.** Writes are deliberately coalesced over a 350 ms window
and capped below the firmware's ~60 commands/minute ceiling, because a device
that exceeds it silently drops the connection.

**`props` says the model cannot report properties.** That is informational, not
an error — some firmware implements only the write half of the protocol. The
status sync does not read properties, so everything still works.

**A light stays lit after an agent stops.** A pane that never reports a final
status expires after `staleAfterMs` (30 minutes by default). Lower it if you
kill agents abruptly.

## How it works

```
Orca agent hooks
      │  agent.status.changed { paneKey, state, worktreeId }
      ▼
AgentStatusTracker ──► group by project ──► one status per project
  (per-pane table)     (worktreeId is           │
   prune stale          <repoId>::<path>)       ▼
                                     ┌── assigned light? ── that project's scene
                                     ├── multiProject cycle? ── one colour each
                                     └── otherwise ── the most urgent status
                                                 │
                                                 ▼
                                        sceneToCommands()
                                                 │  one set_scene where possible
                                                 ▼
                                     YeelightDevice (TCP 55443)
                                     coalesce · rate limit · reconnect
```

Orca runs plugin `main` entries in a forked Node process, so the plugin opens
its own sockets; the sidebar panel is sandboxed with `connect-src 'none'` and is
therefore a static reference rather than a live dashboard.

| File | Role |
| --- | --- |
| `src/protocol.mjs` | wire format, colour maths, scene → commands (pure) |
| `src/scene.mjs` | status tracking and status → scene (pure) |
| `src/discovery.mjs` | SSDP scan on UDP 1982 |
| `src/device.mjs` | one device: connection, reconnect, rate limit |
| `src/controller.mjs` | device set + status → light, shared with the CLI |
| `src/config.mjs` | config load, validation, hot reload |
| `src/index.mjs` | Orca plugin entry: events, commands |

## Tests

```bash
npm test
```

75 tests. The protocol and scene layers are pure and tested directly; the
integration suite drives the real `activate()` entry point against a fake bulb
that speaks the actual protocol, asserting on the commands a device would
receive — including a regression test for firmware that ignores `get_prop`.

## Adding more lights

Discovery adopts every light it finds, so plugging in a second cube needs no
configuration — by default they all mirror the same picture. Use `assignments`
to give a light a project of its own.

## License

MIT
