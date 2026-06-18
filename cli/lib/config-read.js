// Read Brave's on-disk settings to report current tuning state.
//
// STRICTLY READ-ONLY. Brave rewrites Preferences/Local State on shutdown and
// HMAC-protects "Secure Preferences" (super_mac); hand-editing them silently
// reverts or corrupts the profile. We only read here. Durable changes are applied
// through supported channels in apply.js (policy registry + launch-flag wrapper).

import fs from 'node:fs';
import { localStateFile, preferencesFile } from './paths.js';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function get(obj, dotted, fallback = undefined) {
  return dotted.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj) ?? fallback;
}

/**
 * Returns a normalized snapshot of performance-relevant settings.
 * Every field also carries whether the underlying key was present.
 */
export function readBraveConfig(profile = 'Default') {
  const localState = readJson(localStateFile());
  const prefs = readJson(preferencesFile(profile));

  const hwAccel = localState ? get(localState, 'hardware_acceleration_mode.enabled') : undefined;
  const labs = localState ? get(localState, 'browser.enabled_labs_experiments', []) : [];

  // performance_tuning lives under the profile prefs in current Brave/Chromium.
  const batterySaver = prefs ? get(prefs, 'performance_tuning.battery_saver_mode.state') : undefined;
  const highEff = prefs ? get(prefs, 'performance_tuning.high_efficiency_mode.state') : undefined;
  const tabDiscard = prefs ? get(prefs, 'performance_tuning.tab_discarding') : undefined;

  // 0 = default (preloading on), 2 = disabled.
  const netPrediction = prefs ? get(prefs, 'net.network_prediction_options') : undefined;

  const shieldsDisabledCount = prefs ? get(prefs, 'brave.shields.disabled_count') : undefined;

  return {
    found: { localState: !!localState, preferences: !!prefs },
    hardwareAcceleration: hwAccel, // boolean | undefined
    enabledLabsExperiments: Array.isArray(labs) ? labs : [],
    batterySaverState: batterySaver, // 0 off, others on (varies)
    highEfficiencyState: highEff,
    tabDiscarding: tabDiscard,
    networkPrediction: netPrediction, // 0 on (default), 2 off
    shieldsDisabledCount: shieldsDisabledCount,
  };
}
