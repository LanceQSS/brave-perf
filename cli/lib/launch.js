// Launch a dedicated Brave instance with the remote-debugging port open.
//
// Why a separate --user-data-dir: a second Brave pointed at the real profile just
// hands off to the already-running instance and opens NO port. A throwaway profile
// guarantees a fresh process we can attach to, and keeps benchmarks free of the
// user's extensions/Shields so numbers are reproducible.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { benchmarkProfileDir } from './paths.js';

const BASE_ARGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-component-update',
  // Let benchmark videos start without a click so playback metrics are real.
  '--autoplay-policy=no-user-gesture-required',
];

async function portIsUp(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Launch Brave for debugging. Returns { child, port, profileDir, stop() }.
 * `extraArgs` lets callers add performance flags (e.g. --ignore-gpu-blocklist) for A/B runs.
 */
export async function launchBrave(exe, { port = 9222, headless = false, profileDir, extraArgs = [] } = {}) {
  if (await portIsUp(port)) {
    throw new Error(
      `Port ${port} is already serving a CDP endpoint. Close that instance or pass --port to use another.`,
    );
  }
  const userDataDir = profileDir || benchmarkProfileDir();
  fs.mkdirSync(userDataDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    ...BASE_ARGS,
    ...(headless ? ['--headless=new', '--disable-gpu-vsync'] : []),
    ...extraArgs,
    'about:blank',
  ];

  const child = spawn(exe, args, { stdio: 'ignore', detached: false });

  // Wait for the debugging endpoint to come up.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await portIsUp(port)) {
      return {
        child,
        port,
        profileDir: userDataDir,
        stop: () => {
          try {
            child.kill();
          } catch {
            /* already gone */
          }
        },
      };
    }
    if (child.exitCode != null) throw new Error(`Brave exited early (code ${child.exitCode}).`);
    await delay(250);
  }
  child.kill();
  throw new Error('Brave did not open the debugging port within 20s.');
}
