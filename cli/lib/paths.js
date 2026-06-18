// Locating Brave and its profile data on Windows.
// Read-only: we only resolve paths and read JSON; we never write into the live profile.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
const PROGRAMFILES = process.env['ProgramFiles'] || 'C:\\Program Files';
const PROGRAMFILESX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

const KNOWN_EXE_PATHS = [
  path.join(PROGRAMFILES, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  path.join(PROGRAMFILESX86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  path.join(LOCALAPPDATA, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
];

/** Resolve the Brave executable path, trying known locations then the registry. */
export function findBraveExe() {
  for (const p of KNOWN_EXE_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  // Fall back to the App Paths registry key.
  for (const hive of ['HKLM', 'HKCU']) {
    try {
      const out = execFileSync('reg', [
        'query',
        `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\brave.exe`,
        '/ve',
      ], { encoding: 'utf8' });
      const m = out.match(/REG_SZ\s+(.+\.exe)/i);
      if (m && fs.existsSync(m[1].trim())) return m[1].trim();
    } catch {
      // key missing in this hive — try the next
    }
  }
  return null;
}

/** Root of the real Brave profile (the live user data directory). Read-only target. */
export function userDataDir() {
  return path.join(LOCALAPPDATA, 'BraveSoftware', 'Brave-Browser', 'User Data');
}

/** Per-profile Preferences file (defaults to the "Default" profile). */
export function preferencesFile(profile = 'Default') {
  return path.join(userDataDir(), profile, 'Preferences');
}

/** Browser-wide Local State file (GPU mode, enabled flags, etc.). */
export function localStateFile() {
  return path.join(userDataDir(), 'Local State');
}

/** A throwaway profile dir used only for clean-room benchmarking (never the real profile). */
export function benchmarkProfileDir() {
  return path.join(process.env.TEMP || LOCALAPPDATA, 'brave-perf-bench-profile');
}

/** Brave's reported version, parsed from the Application folder layout, if available. */
export function braveVersion(exe) {
  if (!exe) return null;
  try {
    const appDir = path.dirname(exe); // ...\Application
    const entries = fs.readdirSync(appDir, { withFileTypes: true });
    const versions = entries
      .filter((e) => e.isDirectory() && /^\d+\.\d+\.\d+\.\d+$/.test(e.name))
      .map((e) => e.name)
      .sort();
    return versions.at(-1) || null;
  } catch {
    return null;
  }
}

export const env = { LOCALAPPDATA, PROGRAMFILES, PROGRAMFILESX86 };
