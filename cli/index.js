#!/usr/bin/env node
// brave-perf — measure and maximize Brave performance (YouTube + general browsing) on Windows.

import { findBraveExe, braveVersion, benchmarkProfileDir, userDataDir } from './lib/paths.js';
import { readBraveConfig } from './lib/config-read.js';
import { launchBrave } from './lib/launch.js';
import { connectBrowser } from './lib/cdp.js';
import { measureUrl, DEFAULT_PAGES, DEFAULT_YOUTUBE } from './lib/benchmark.js';
import { buildRecommendations, FIX } from './lib/recommend.js';
import { applyFixes, revertAll, OPTIMIZED_FLAGS } from './lib/apply.js';
import { c, heading, kv, line, recommendation, ms, bytes } from './lib/report.js';

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      flags[k] = v === undefined ? true : v;
    } else positional.push(a);
  }
  return { flags, positional };
}

function requireBrave() {
  const exe = findBraveExe();
  if (!exe) {
    console.error(c.red('Could not find brave.exe. Pass --exe="C:\\path\\to\\brave.exe".'));
    process.exit(1);
  }
  return exe;
}

// ---- doctor ----------------------------------------------------------------
function cmdDoctor(flags) {
  heading('Environment');
  const exe = flags.exe || findBraveExe();
  kv('Brave.exe', exe || 'NOT FOUND', exe ? { good: true } : { bad: true });
  kv('Brave version', braveVersion(exe) || 'unknown');
  kv('User Data (real profile)', userDataDir());
  kv('Benchmark profile (temp)', benchmarkProfileDir());
  kv('Node', process.version, { good: Number(process.versions.node.split('.')[0]) >= 22 });
  kv('Global WebSocket', typeof WebSocket !== 'undefined' ? 'available' : 'MISSING (need Node >= 22)', {
    good: typeof WebSocket !== 'undefined',
    bad: typeof WebSocket === 'undefined',
  });
  line('\n' + c.dim('  Tip: run `audit` for a read-only config review, `benchmark` to measure live.'));
}

// ---- audit (read-only) -----------------------------------------------------
function cmdAudit(flags) {
  const config = readBraveConfig(flags.profile || 'Default');
  heading('Brave configuration (read-only)');
  if (!config.found.localState && !config.found.preferences) {
    line(c.yellow('  Could not read Local State / Preferences. Is this a fresh or running profile?'));
  }
  kv('Hardware acceleration', String(config.hardwareAcceleration ?? 'unknown'), {
    good: config.hardwareAcceleration === true,
    bad: config.hardwareAcceleration === false,
  });
  kv('Preloading (net prediction)', config.networkPrediction === 2 ? 'disabled' : 'enabled/default', {
    warn: config.networkPrediction === 2,
  });
  kv('Battery saver state', String(config.batterySaverState ?? 'n/a'));
  kv('High-efficiency (memory) state', String(config.highEfficiencyState ?? 'n/a'));
  kv('GPU labs flags', (config.enabledLabsExperiments.filter((f) => /gpu|zero-copy|graphite|raster/.test(f)).join(', ') || 'none'));
  kv('Shields disabled on N sites', String(config.shieldsDisabledCount ?? 'n/a'));

  const recs = buildRecommendations({ config });
  heading('Recommendations');
  if (!recs.length) line(c.green('  Looks well tuned. Run `benchmark` for live YouTube/codec analysis.'));
  recs.forEach((r, i) => recommendation(r, i + 1));
  line('\n' + c.dim('  Auto-apply the registry/launcher fixes with: ') + c.bold('node cli/index.js apply'));
}

// ---- benchmark -------------------------------------------------------------
async function cmdBenchmark(flags) {
  const exe = flags.exe || requireBrave();
  const port = Number(flags.port || 9222);
  const headless = !!flags.headless;
  const pages = flags.pages ? String(flags.pages).split(',') : DEFAULT_PAGES;
  const ytDisabled = flags.youtube === false || flags.youtube === 'false';
  const ytUrl = ytDisabled
    ? null
    : typeof flags.youtube === 'string'
      ? flags.youtube
      : DEFAULT_YOUTUBE;

  line(c.dim(`Launching Brave (debug, temp profile)${headless ? ' headless' : ''} on port ${port}…`));
  const inst = await launchBrave(exe, { port, headless, extraArgs: flags.optimized ? OPTIMIZED_FLAGS : [] });
  const results = [];
  let youtube = null;
  try {
    const { client, info } = await connectBrowser(port);
    line(c.dim(`Connected: ${info.Browser}`));
    try {
      for (const url of pages) {
        line(c.dim(`  measuring ${url} …`));
        results.push(await measureUrl(client, url, { settleMs: Number(flags.settle || 4000) }));
      }
      if (ytUrl) {
        line(c.dim(`  measuring YouTube ${ytUrl} …`));
        youtube = await measureUrl(client, ytUrl, { isYouTube: true });
      }
    } finally {
      client.close();
    }
  } finally {
    inst.stop();
  }

  // ---- render page results ----
  heading('Page performance');
  for (const r of results) {
    line('\n  ' + c.bold(r.url));
    if (r.error) {
      line('   ' + c.red('error: ' + r.error));
      continue;
    }
    const v = r.vitals || {};
    const p = r.perf || {};
    kv('LCP', ms(v.lcp), { good: v.lcp != null && v.lcp < 2500, bad: v.lcp > 4000 });
    kv('CLS', v.cls != null ? v.cls.toFixed(3) : 'n/a', { good: v.cls < 0.1, bad: v.cls > 0.25 });
    kv('INP (max event)', ms(v.inp), { good: v.inp != null && v.inp < 200, warn: v.inp >= 200 });
    kv('TTFB', ms(v.ttfb));
    kv('Load event', ms(v.loadEvent));
    kv('CPU during settle', p.cpuPercent != null ? p.cpuPercent + ' %' : 'n/a', { warn: p.cpuPercent > 60 });
    kv('Long tasks', `${v.longTasks} (${v.longTaskMs} ms)`, { warn: v.longTaskMs > 500 });
    kv('JS heap', bytes(v.jsHeapUsed));
    kv('Transfer size', bytes(v.transferSize));
  }

  // ---- render YouTube ----
  if (youtube && !youtube.error) {
    heading('YouTube');
    const yt = youtube.youtube || {};
    if (yt.video) {
      kv('Resolution', `${yt.video.width}x${yt.video.height}`);
      kv('Dropped frames', `${yt.video.dropped}/${yt.video.total} (${yt.video.dropPct}%)`, {
        good: yt.video.dropPct < 1,
        bad: yt.video.dropPct > 5,
      });
    }
    kv('Active codec', yt.codec || 'unknown', { warn: yt.codec === 'AV1' || yt.codec === 'VP9' });
    if (yt.stats) kv('Stats-for-nerds codecs', yt.stats.codecs || 'n/a');
    if (yt.decode) {
      for (const [name, d] of Object.entries(yt.decode)) {
        kv(`Decode ${name}`, d.supported ? (d.powerEfficient ? 'hardware ✓' : 'SOFTWARE ✗') : 'unsupported', {
          good: d.powerEfficient,
          bad: d.supported && !d.powerEfficient,
        });
      }
    }
    kv('CPU during playback', youtube.perf?.cpuPercent != null ? youtube.perf.cpuPercent + ' %' : 'n/a', {
      warn: youtube.perf?.cpuPercent > 40,
    });
  } else if (youtube?.error) {
    heading('YouTube');
    line('  ' + c.red('error: ' + youtube.error));
  }

  // ---- recommendations ----
  const config = readBraveConfig(flags.profile || 'Default');
  const recs = buildRecommendations({ config, benchmark: { youtube } });
  heading('Recommendations');
  if (!recs.length) line(c.green('  No issues found.'));
  recs.forEach((r, i) => recommendation(r, i + 1));
  line('\n' + c.dim('  Apply browser-wide fixes: ') + c.bold('node cli/index.js apply'));
}

// ---- apply / revert --------------------------------------------------------
function cmdApply(flags) {
  const exe = flags.exe || findBraveExe();
  // Which fixes? Default: everything auto-applicable from a fresh audit.
  let ids;
  if (flags.only) {
    ids = String(flags.only).split(',');
  } else {
    const recs = buildRecommendations({ config: readBraveConfig(flags.profile || 'Default') });
    ids = recs.filter((r) => r.autoApplicable).map((r) => r.id);
    // Always offer the GPU launcher even if labs flag detection is ambiguous.
    if (!ids.includes(FIX.GPU_BLOCKLIST) && flags.gpu) ids.push(FIX.GPU_BLOCKLIST);
  }
  if (!ids.length) {
    line(c.green('Nothing to auto-apply — config already looks tuned. (Use --only=… to force.)'));
    return;
  }

  const dryRun = !flags.yes;
  const { actions, requiresRelaunch } = applyFixes(ids, { braveExe: exe, dryRun });
  heading(dryRun ? 'Apply — DRY RUN (no changes made)' : 'Apply — changes written');
  for (const a of actions) line(`  ${c.cyan(a.kind)}  ${a.detail}`);
  if (dryRun) {
    line('\n' + c.yellow('  This was a preview. Re-run with --yes to apply:'));
    line('  ' + c.bold(`node cli/index.js apply --yes${flags.only ? ` --only=${flags.only}` : ''}`));
  } else {
    line('\n' + c.green('  Applied.') + (requiresRelaunch ? ' Fully quit and reopen Brave for changes to take effect.' : ''));
    line(c.dim('  Undo anytime with: ') + c.bold('node cli/index.js revert --yes'));
  }
}

function cmdRevert(flags) {
  const dryRun = !flags.yes;
  const { actions, nothing } = revertAll({ dryRun });
  heading(dryRun ? 'Revert — DRY RUN' : 'Revert — undone');
  if (nothing) {
    line(c.dim('  Nothing recorded to revert.'));
    return;
  }
  for (const a of actions) line(`  ${c.cyan(a.kind)}  ${a.detail}`);
  if (dryRun) line('\n' + c.yellow('  Re-run with --yes to revert.'));
  else line('\n' + c.green('  Reverted. Relaunch Brave.'));
}

// ---- help ------------------------------------------------------------------
function help() {
  line(`${c.bold('brave-perf')} — measure & maximize Brave performance (Windows)

${c.bold('Usage')}: node cli/index.js <command> [options]

${c.bold('Commands')}
  doctor                 Check Brave path, version, Node/WebSocket readiness
  audit                  Read-only review of Brave's config + recommendations
  benchmark              Launch a debug Brave, measure pages + YouTube, recommend
  apply                  Auto-apply browser-wide fixes (policy registry + launcher)
  revert                 Undo everything apply changed

${c.bold('Options')}
  --exe=PATH             Override Brave.exe location
  --port=9222            Debug port for benchmark
  --headless             Run benchmark without a visible window
  --pages=a,b,c          Comma-separated URLs to benchmark
  --youtube=URL|false    Override / disable the YouTube test
  --optimized            Benchmark WITH the optimized GPU flags (for A/B)
  --only=id1,id2         apply: only these fix ids (${Object.values(FIX).join(', ')})
  --yes                  apply/revert: actually make changes (otherwise dry-run)

${c.dim('Safe by default: audit/benchmark never modify Brave; apply previews unless --yes.')}`);
}

// ---- main ------------------------------------------------------------------
const { flags, positional } = parseArgs(process.argv.slice(2));
const cmd = positional[0] || 'help';
try {
  if (cmd === 'doctor') cmdDoctor(flags);
  else if (cmd === 'audit') cmdAudit(flags);
  else if (cmd === 'benchmark') await cmdBenchmark(flags);
  else if (cmd === 'apply') cmdApply(flags);
  else if (cmd === 'revert') cmdRevert(flags);
  else help();
} catch (err) {
  console.error('\n' + c.red('✗ ' + (err?.message || err)));
  process.exit(1);
}
