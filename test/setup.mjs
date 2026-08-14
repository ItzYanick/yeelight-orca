/**
 * Test bootstrap, loaded via `node --import` before any test module.
 *
 * Why this exists rather than each test setting its own path: `src/config.mjs`
 * resolves CONFIG_PATH once, at first import. Any test file that pulls that
 * module in before setting the override silently binds it to the developer's
 * real `~/.orca/yeelight.json` — and the toggle-command test *writes* to that
 * path. That is not hypothetical: it once flipped `"enabled": false` in a live
 * config and left the user's actual lights dark until someone noticed.
 *
 * Running before every test module removes the ordering hazard entirely, so a
 * new test file cannot reintroduce it by importing something in the wrong
 * order.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REAL_CONFIG = path.join(os.homedir(), '.orca', 'yeelight.json');

if (!process.env.ORCA_YEELIGHT_CONFIG) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yeelight-orca-test-'));
  process.env.ORCA_YEELIGHT_CONFIG = path.join(dir, 'yeelight.json');
}

// A belt-and-braces stop: never let a suite run against the real file, even if
// someone exports ORCA_YEELIGHT_CONFIG by hand.
if (path.resolve(process.env.ORCA_YEELIGHT_CONFIG) === path.resolve(REAL_CONFIG)) {
  throw new Error(
    'refusing to run tests against the real config at ~/.orca/yeelight.json — ' +
      'unset ORCA_YEELIGHT_CONFIG or point it somewhere disposable'
  );
}
