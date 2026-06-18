// Browser-wide auto-apply — via SUPPORTED, reversible channels only.
//
//  1. Enterprise-policy registry under HKCU\Software\Policies\BraveSoftware\Brave.
//     Brave reads policies from HKCU (no admin needed) and they survive updates.
//     We NEVER touch Preferences/Local State JSON (Brave rewrites + HMAC-guards those).
//  2. An "optimized launcher" (.cmd + Desktop .lnk) that starts Brave with GPU flags.
//
// Everything we change is recorded to apply-state.json so `revert` undoes exactly it.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { FIX } from './recommend.js';

const POLICY_KEY = 'HKCU:\\Software\\Policies\\BraveSoftware\\Brave';
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATE_FILE = path.join(PROJECT_ROOT, 'apply-state.json');

const OPTIMIZED_FLAGS = ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--enable-zero-copy'];

function ps(command) {
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
  });
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { policies: [], files: [] };
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Escape a value for embedding inside a single-quoted PowerShell string literal.
const psq = (s) => String(s).replace(/'/g, "''");

function getPolicyValue(name) {
  try {
    const out = ps(
      `$ErrorActionPreference='SilentlyContinue';` +
        `if (Test-Path '${POLICY_KEY}') { (Get-ItemProperty -Path '${POLICY_KEY}' -Name '${psq(name)}').'${psq(name)}' }`,
    ).trim();
    return out === '' ? null : out;
  } catch {
    return null; // not set
  }
}

function setPolicyValue(name, value, type = 'DWord') {
  ps(`if (-not (Test-Path '${POLICY_KEY}')) { New-Item -Path '${POLICY_KEY}' -Force | Out-Null }`);
  const valArg = type === 'DWord' ? String(Number(value)) : `'${psq(value)}'`;
  ps(
    `New-ItemProperty -Path '${POLICY_KEY}' -Name '${psq(name)}' -Value ${valArg} ` +
      `-PropertyType ${type} -Force | Out-Null`,
  );
}

function removePolicy(name, restoreTo) {
  if (restoreTo == null) {
    ps(`Remove-ItemProperty -Path '${POLICY_KEY}' -Name '${psq(name)}' -ErrorAction SilentlyContinue`);
  } else if (typeof restoreTo === 'number') {
    setPolicyValue(name, restoreTo, 'DWord');
  } else {
    // Original value wasn't a plain integer (e.g. a REG_SZ set by GPO) — restore as text.
    setPolicyValue(name, restoreTo, 'String');
  }
}

// Map fix ids to concrete policy writes.
const POLICY_FIXES = {
  [FIX.HW_ACCEL]: { name: 'HardwareAccelerationModeEnabled', value: 1 },
  [FIX.PRELOAD]: { name: 'NetworkPredictionOptions', value: 0 },
};

function makeOptimizedLauncher(braveExe) {
  const created = [];
  const cmdPath = path.join(PROJECT_ROOT, 'Start Brave (optimized).cmd');
  const cmd = `@echo off\r\nstart "" "${braveExe}" ${OPTIMIZED_FLAGS.join(' ')}\r\n`;
  fs.writeFileSync(cmdPath, cmd);
  created.push(cmdPath);

  // Desktop shortcut for convenience.
  try {
    const desktop = path.join(os.homedir(), 'Desktop');
    const lnkPath = path.join(desktop, 'Brave (optimized).lnk');
    const args = OPTIMIZED_FLAGS.join(' ');
    ps(
      `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${psq(lnkPath)}');` +
        `$s.TargetPath='${psq(braveExe)}';$s.Arguments='${psq(args)}';` +
        `$s.IconLocation='${psq(braveExe)},0';$s.Save()`,
    );
    created.push(lnkPath);
  } catch {
    // Desktop shortcut is best-effort; the .cmd still works.
  }
  return created;
}

/**
 * Apply the selected fixes. `fixIds` is an array of FIX.* ids; `dryRun` reports without changing.
 * Returns a summary of actions.
 */
export function applyFixes(fixIds, { braveExe, dryRun = false } = {}) {
  const actions = [];
  const state = readState();

  // Validate preconditions BEFORE any mutation, so we never leave half-applied
  // registry writes if a later step (the launcher) can't run.
  if (!dryRun && fixIds.includes(FIX.GPU_BLOCKLIST) && !braveExe) {
    throw new Error('Cannot create the optimized launcher: Brave.exe not found. Pass --exe=PATH.');
  }

  for (const id of fixIds) {
    const pol = POLICY_FIXES[id];
    if (pol) {
      const prior = getPolicyValue(pol.name);
      actions.push({ kind: 'policy', id, detail: `${pol.name} = ${pol.value} (was ${prior ?? 'unset'})`, dryRun });
      if (!dryRun) {
        setPolicyValue(pol.name, pol.value, 'DWord');
        // Record only the first time we touch it, preserving the original value.
        // Keep the raw string if it wasn't a plain integer (don't coerce to NaN -> null).
        if (!state.policies.find((p) => p.name === pol.name)) {
          let restoreTo = null;
          if (prior != null) {
            const n = Number(prior);
            restoreTo = Number.isFinite(n) ? n : prior;
          }
          state.policies.push({ name: pol.name, restoreTo });
        }
        writeState(state); // persist after each mutation so revert is always accurate
      }
      continue;
    }
    if (id === FIX.GPU_BLOCKLIST) {
      actions.push({
        kind: 'launcher',
        id,
        detail: `optimized launcher with ${OPTIMIZED_FLAGS.join(' ')}`,
        dryRun,
      });
      if (!dryRun) {
        const files = makeOptimizedLauncher(braveExe);
        for (const f of files) if (!state.files.includes(f)) state.files.push(f);
        writeState(state); // persist after creating files
      }
      continue;
    }
    actions.push({ kind: 'skip', id, detail: 'applied in-browser via the extension (not a registry/launcher change)' });
  }

  if (!dryRun) writeState(state);
  return { actions, stateFile: STATE_FILE, requiresRelaunch: true };
}

/** Undo everything recorded in apply-state.json. */
export function revertAll({ dryRun = false } = {}) {
  const state = readState();
  const actions = [];
  for (const p of state.policies) {
    actions.push({ kind: 'policy', detail: `restore ${p.name} -> ${p.restoreTo ?? 'unset'}`, dryRun });
    if (!dryRun) removePolicy(p.name, p.restoreTo);
  }
  for (const f of state.files) {
    actions.push({ kind: 'file', detail: `delete ${f}`, dryRun });
    if (!dryRun) fs.rmSync(f, { force: true });
  }
  if (!dryRun) writeState({ policies: [], files: [] });
  return { actions, nothing: state.policies.length === 0 && state.files.length === 0 };
}

export { STATE_FILE, OPTIMIZED_FLAGS };
