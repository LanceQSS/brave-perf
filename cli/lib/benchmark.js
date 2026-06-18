// Orchestrates a measurement run against a debug-enabled Brave instance.

import { setTimeout as delay } from 'node:timers/promises';
import { openPage, evaluate } from './cdp.js';
import { INSTALL_VITALS, READ_VITALS, READ_YOUTUBE } from './page-metrics.js';

// Diff two Performance.getMetrics snapshots into useful rates/totals.
function diffMetrics(a, b, wallMs) {
  const toMap = (arr) => Object.fromEntries(arr.map((m) => [m.name, m.value]));
  const A = toMap(a);
  const B = toMap(b);
  const d = (k) => (B[k] ?? 0) - (A[k] ?? 0);
  // ProcessTime/ThreadTime are seconds of CPU; convert the delta to a % of wall time.
  const cpuSec = d('ProcessTime');
  return {
    cpuPercent: wallMs ? +((cpuSec * 1000) / wallMs * 100).toFixed(1) : null,
    scriptMs: Math.round(d('ScriptDuration') * 1000),
    layoutMs: Math.round(d('LayoutDuration') * 1000),
    recalcStyleMs: Math.round(d('RecalcStyleDuration') * 1000),
    layoutCount: d('LayoutCount'),
    recalcStyleCount: d('RecalcStyleCount'),
    jsHeapUsed: B['JSHeapUsedSize'] ?? null,
    nodes: B['Nodes'] ?? null,
    documents: B['Documents'] ?? null,
  };
}

async function getMetrics(client, sessionId) {
  try {
    const { metrics } = await client.send('Performance.getMetrics', {}, sessionId);
    return metrics;
  } catch {
    return [];
  }
}

/**
 * Measure a single URL. settleMs is the active observation window after load.
 * Returns { url, error?, vitals, perf, youtube }.
 */
export async function measureUrl(client, url, { settleMs = 4000, isYouTube = false } = {}) {
  const { sessionId, closeTab } = await openPage(client, 'about:blank');
  const result = { url, vitals: null, perf: null, youtube: null };
  try {
    // Install observers, then navigate (document-level reset keeps them via buffered:true on re-eval).
    await client.send('Page.navigate', { url }, sessionId);
    // Re-install after navigation commits so observers attach to the new document.
    await delay(300);
    await evaluate(client, sessionId, INSTALL_VITALS, { awaitPromise: false });

    // Wait for load (best effort).
    await client
      .once('Page.loadEventFired', { sessionId, timeout: 15_000 })
      .catch(() => {});

    const before = await getMetrics(client, sessionId);
    const t0 = Date.now();
    // YouTube needs longer to settle into steady-state playback.
    await delay(isYouTube ? Math.max(settleMs, 8000) : settleMs);
    const wallMs = Date.now() - t0;
    const after = await getMetrics(client, sessionId);

    result.perf = diffMetrics(before, after, wallMs);
    result.vitals = await evaluate(client, sessionId, READ_VITALS, { awaitPromise: false });
    if (isYouTube) result.youtube = await evaluate(client, sessionId, READ_YOUTUBE);
  } catch (err) {
    result.error = err.message;
  } finally {
    await closeTab();
  }
  return result;
}

export const DEFAULT_PAGES = [
  'https://en.wikipedia.org/wiki/Web_performance',
  'https://www.nytimes.com/',
  'https://www.reddit.com/',
];

export const DEFAULT_YOUTUBE = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'; // Big Buck Bunny (stable, long)
