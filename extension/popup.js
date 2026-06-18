// Popup logic: system stats, current-page vitals, YouTube codec toggle.

const $ = (id) => document.getElementById(id);
const CODEC_KEY = 'bravePerfCodec';

function cls(el, kind) {
  el.classList.remove('good', 'warn', 'bad');
  if (kind) el.classList.add(kind);
}

// ---- system CPU% (diff two samples) + memory ----
async function systemStats() {
  try {
    const a = await chrome.system.cpu.getInfo();
    await new Promise((r) => setTimeout(r, 700));
    const b = await chrome.system.cpu.getInfo();
    let busy = 0;
    let total = 0;
    // Core count can change between samples (core parking); only diff overlapping indices.
    const n = Math.min(a.processors.length, b.processors.length);
    for (let i = 0; i < n; i++) {
      const p = a.processors[i].usage;
      const q = b.processors[i]?.usage;
      if (!p || !q) continue;
      const dTotal = q.total - p.total;
      const dIdle = q.idle - p.idle;
      busy += dTotal - dIdle;
      total += dTotal;
    }
    const pct = total ? Math.round((busy / total) * 100) : 0;
    $('cpu').textContent = pct + ' %';
    cls($('cpu'), pct > 80 ? 'bad' : pct > 50 ? 'warn' : 'good');

    const m = await chrome.system.memory.getInfo();
    const usedPct = Math.round((1 - m.availableCapacity / m.capacity) * 100);
    $('mem').textContent = `${usedPct}% of ${(m.capacity / 1024 ** 3).toFixed(0)} GB`;
    cls($('mem'), usedPct > 90 ? 'bad' : usedPct > 75 ? 'warn' : 'good');
  } catch (e) {
    $('cpu').textContent = 'n/a';
    $('mem').textContent = 'n/a';
  }
}

const fmtMs = (n) => (n == null ? '—' : Math.round(n) + ' ms');

// ---- current-page vitals ----
function pageVitals(tabId) {
  chrome.tabs.sendMessage(tabId, { type: 'get-vitals' }, (v) => {
    if (chrome.runtime.lastError || !v) {
      ['lcp', 'cls', 'inp', 'ttfb'].forEach((id) => ($(id).textContent = 'n/a'));
      return;
    }
    $('lcp').textContent = fmtMs(v.lcp);
    cls($('lcp'), v.lcp == null ? null : v.lcp < 2500 ? 'good' : v.lcp > 4000 ? 'bad' : 'warn');
    $('cls').textContent = v.cls != null ? v.cls.toFixed(3) : '—';
    cls($('cls'), v.cls == null ? null : v.cls < 0.1 ? 'good' : v.cls > 0.25 ? 'bad' : 'warn');
    $('inp').textContent = fmtMs(v.inp);
    cls($('inp'), v.inp == null ? null : v.inp < 200 ? 'good' : v.inp > 500 ? 'bad' : 'warn');
    $('ttfb').textContent = fmtMs(v.ttfb);
  });
}

// ---- YouTube codec ----
async function setupYouTube(tab) {
  const isYT = tab.url && tab.url.includes('youtube.com');
  $('yt-card').style.opacity = isYT ? '1' : '0.55';

  const stored = (await chrome.storage.local.get([CODEC_KEY]))[CODEC_KEY] || {};
  const forced = !!(stored.blockAV1 && stored.blockVP9);
  $('force-h264').checked = forced;

  $('force-h264').addEventListener('change', async (e) => {
    const on = e.target.checked;
    await chrome.storage.local.set({
      [CODEC_KEY]: { blockAV1: on, blockVP9: on, blockVP8: on },
    });
    $('yt-hint').textContent = on
      ? 'H.264 forced. Reload the YouTube tab to apply to the current video.'
      : 'H.264 forcing off. Reload the YouTube tab to restore AV1/VP9.';
  });

  if (!isYT) {
    $('yt-codec').textContent = 'open a YouTube tab';
    $('yt-drops').textContent = '—';
    return;
  }
  // Target the top frame only — sub-frames (embeds/ads) carry the bridge too and an
  // empty one could win the response race and report the wrong codec.
  chrome.tabs.sendMessage(tab.id, { type: 'get-yt-stats' }, { frameId: 0 }, (s) => {
    if (chrome.runtime.lastError || !s) {
      $('yt-codec').textContent = 'no video playing';
      return;
    }
    $('yt-codec').textContent = s.codec || 'unknown';
    cls($('yt-codec'), s.codec === 'H.264' ? 'good' : s.codec === 'AV1' || s.codec === 'VP9' ? 'warn' : null);
    if (s.video) {
      $('yt-drops').textContent = `${s.video.dropped}/${s.video.total} (${s.video.dropPct}%)`;
      cls($('yt-drops'), s.video.dropPct < 1 ? 'good' : s.video.dropPct > 5 ? 'bad' : 'warn');
    }
  });
}

async function main() {
  systemStats();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    pageVitals(tab.id);
    setupYouTube(tab);
  }
}

main();
