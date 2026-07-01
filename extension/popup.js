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

// ---- YouTube decode-capability probe ----
// decodingInfo reports a GPU/browser capability, not page state, so it runs directly
// in the popup's own document — no content-script round-trip needed. The probe strings
// mirror cli/lib/page-metrics.js so the popup and the CLI reach the same verdict.
const PROBE = {
  AV1: 'video/mp4; codecs="av01.0.08M.08"',
  VP9: 'video/webm; codecs="vp09.00.40.08"',
  'H.264': 'video/mp4; codecs="avc1.640028"',
};

async function probeDecode() {
  const mc = navigator.mediaCapabilities;
  if (!mc || typeof mc.decodingInfo !== 'function') return null;
  const one = (contentType) =>
    mc
      .decodingInfo({
        type: 'media-source',
        video: { contentType, width: 1920, height: 1080, bitrate: 5_000_000, framerate: 30 },
      })
      .then((r) => ({ supported: r.supported, powerEfficient: r.powerEfficient }))
      .catch(() => null);
  const [av1, vp9, h264] = await Promise.all([one(PROBE.AV1), one(PROBE.VP9), one(PROBE['H.264'])]);
  if (!av1 && !vp9 && !h264) return null;
  return { AV1: av1, VP9: vp9, 'H.264': h264 };
}

// Mirrors the CLI's triage (cli/lib/recommend.js): forcing H.264 only helps when a
// heavy codec decodes in SOFTWARE here AND H.264 decodes in HARDWARE. Unlike the CLI,
// a heavy codec the GPU can't decode at all (supported:false) is treated as "no reason
// to force" — YouTube won't serve a codec the machine can't play.
function classifyDecode(d) {
  if (!d || !d.AV1 || !d.VP9 || !d['H.264']) return { verdict: 'unknown' };
  const hw = (c) => !!(c && c.supported && c.powerEfficient);
  const sw = (c) => !!(c && c.supported && !c.powerEfficient);
  const av1Hw = hw(d.AV1);
  const vp9Hw = hw(d.VP9);
  const h264Hw = hw(d['H.264']);
  const heavySoftware = sw(d.AV1) || sw(d.VP9);
  if (av1Hw && vp9Hw) return { verdict: 'not-needed' };
  if (heavySoftware && h264Hw) return { verdict: 'recommended' };
  return { verdict: 'neutral' };
}

function renderHwRow(d) {
  if (!d) {
    $('yt-hwdec').textContent = 'n/a';
    return;
  }
  const mark = (c) => (!c ? '?' : c.supported ? (c.powerEfficient ? '✓' : 'sw') : '✗');
  $('yt-hwdec').textContent = `AV1 ${mark(d.AV1)} · VP9 ${mark(d.VP9)} · H.264 ${mark(d['H.264'])}`;
}

const REC_HINT = {
  'not-needed':
    'This GPU hardware-decodes AV1 and VP9 — forcing H.264 gives no CPU benefit, raises bandwidth, and caps resolution (~1080p). Not needed here.',
  recommended:
    'Recommended: a heavy codec decodes in software on this GPU while H.264 decodes in hardware, so forcing H.264 should lower CPU.',
  neutral:
    'Only helps on GPUs without AV1/VP9 hardware decode. Caps some videos at 1080p.',
  unknown:
    'Could not probe decode capability. Force H.264 only helps on GPUs without AV1/VP9 hardware decode; it caps some videos at 1080p.',
};

// Gate the toggle by capability. Never disable while forcing is ON — the user must
// always be able to turn a net-negative setting back off.
function applyRecommendation(verdict, forced, isYT) {
  const toggle = $('force-h264');
  toggle.disabled = verdict === 'not-needed' && !forced;
  let hint = REC_HINT[verdict] || REC_HINT.unknown;
  // Only promise auto-reload where it actually happens: a YouTube tab with a usable toggle.
  if (isYT && !toggle.disabled) hint += ' Toggling reloads YouTube automatically.';
  $('yt-hint').textContent = hint;
}

// ---- YouTube codec ----
async function setupYouTube(tab) {
  const isYT = !!(tab.url && tab.url.includes('youtube.com'));
  $('yt-card').style.opacity = isYT ? '1' : '0.55';

  const stored = (await chrome.storage.local.get([CODEC_KEY]))[CODEC_KEY] || {};
  const forced = !!(stored.blockAV1 && stored.blockVP9 && stored.blockVP8);
  $('force-h264').checked = forced;

  // Probe GPU decode capability in the popup document and gate the toggle accordingly.
  const decode = await probeDecode();
  renderHwRow(decode);
  const verdict = classifyDecode(decode).verdict;
  applyRecommendation(verdict, forced, isYT);

  $('force-h264').addEventListener('change', async (e) => {
    const on = e.target.checked;
    await chrome.storage.local.set({
      [CODEC_KEY]: { blockAV1: on, blockVP9: on, blockVP8: on },
    });
    // Reload the active YouTube tab so the codec patch applies to the next load
    // deterministically: the isolated bridge re-pushes config (yt-bridge.js) before
    // the player queries codecs. The genuinely-cold first-ever YouTube visit may still
    // need one manual reload — the sync localStorage mirror cannot cover cold start.
    if (isYT) {
      $('yt-hint').textContent = on
        ? 'Forcing H.264 — reloading YouTube. Reopen this popup to confirm the codec.'
        : 'Restoring AV1/VP9 — reloading YouTube.';
      chrome.tabs.reload(tab.id);
    } else {
      $('yt-hint').textContent = on
        ? 'H.264 will be forced the next time you open YouTube.'
        : 'H.264 forcing off; AV1/VP9 restored on the next YouTube load.';
    }
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
    // Post-reload verification: when forcing is on, measure whether the codec actually
    // switched instead of asserting success from the checkbox state.
    if (forced && s.codec && s.codec !== 'unknown') {
      if (s.codec === 'H.264') {
        $('yt-hint').textContent =
          verdict === 'not-needed'
            ? '✓ Serving H.264 — but this GPU decodes AV1/VP9 in hardware, so you can turn this off.'
            : '✓ Confirmed: serving H.264 (hardware decode).';
      } else {
        $('yt-hint').textContent = `⚠ Still serving ${s.codec} — force didn’t apply. Reload the tab.`;
      }
    }
  });
}

async function main() {
  $('ver').textContent = 'v' + chrome.runtime.getManifest().version;
  systemStats();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    pageVitals(tab.id);
    setupYouTube(tab);
  }
}

main();
