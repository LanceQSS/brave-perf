// Runs in the page MAIN world at document_start, BEFORE the YouTube player loads.
// Monkey-patches codec-support checks so YouTube serves a codec that decodes in
// hardware. This is the proven "h264ify" technique. Reversible: remove the extension.
//
// Config is read SYNCHRONOUSLY from localStorage so the patch is correct on the very
// first codec query after a reload (chrome.storage is async + unavailable in MAIN world;
// the isolated bridge mirrors the setting into localStorage for us).

(() => {
  const LS_KEY = '__bravePerfCodec';
  const cfg = { blockAV1: false, blockVP9: false, blockVP8: false };

  function load() {
    try {
      Object.assign(cfg, JSON.parse(localStorage.getItem(LS_KEY) || '{}'));
    } catch {
      /* malformed / blocked storage — keep defaults (no blocking) */
    }
  }
  load();

  function blocked(mime) {
    if (typeof mime !== 'string') return false;
    const m = mime.toLowerCase();
    if (cfg.blockAV1 && m.includes('av01')) return true;
    if (cfg.blockVP9 && (m.includes('vp9') || m.includes('vp09'))) return true;
    // VP8 appears as the bare token "vp8" or the WebM fourCC "vp08" (which does NOT
    // contain the substring "vp8"); match both, but never misfire on VP9 strings.
    if (cfg.blockVP8 && (m.includes('vp8') || m.includes('vp08')) && !m.includes('vp9') && !m.includes('vp09')) {
      return true;
    }
    return false;
  }

  // 1) MediaSource.isTypeSupported — what MSE-based playback (YouTube) consults.
  if (window.MediaSource && MediaSource.isTypeSupported) {
    const orig = MediaSource.isTypeSupported.bind(MediaSource);
    MediaSource.isTypeSupported = (mime) => (blocked(mime) ? false : orig(mime));
  }
  // 2) HTMLMediaElement.canPlayType — the legacy fallback path.
  const origCanPlay = HTMLMediaElement.prototype.canPlayType;
  HTMLMediaElement.prototype.canPlayType = function (mime) {
    return blocked(mime) ? '' : origCanPlay.call(this, mime);
  };
  // 3) MediaCapabilities.decodingInfo — modern YouTube drives codec selection from
  //    this (smooth/powerEfficient). Without patching it, blocked codecs still look
  //    available and the "Force H.264" toggle fails on decodingInfo-gated builds.
  const mc = navigator.mediaCapabilities;
  if (mc && typeof mc.decodingInfo === 'function') {
    const origDecoding = mc.decodingInfo.bind(mc);
    mc.decodingInfo = (config) => {
      try {
        if (blocked(config?.video?.contentType)) {
          return Promise.resolve({ supported: false, smooth: false, powerEfficient: false });
        }
      } catch {
        /* fall through to the real implementation */
      }
      return origDecoding(config);
    };
  }

  // Read current playback stats from the YouTube player for the popup overlay.
  function readStats() {
    const out = { codec: null, video: null, stats: null };
    const v = document.querySelector('video');
    if (v && v.getVideoPlaybackQuality) {
      const q = v.getVideoPlaybackQuality();
      out.video = {
        total: q.totalVideoFrames,
        dropped: q.droppedVideoFrames,
        dropPct: q.totalVideoFrames ? +((q.droppedVideoFrames / q.totalVideoFrames) * 100).toFixed(2) : 0,
        width: v.videoWidth,
        height: v.videoHeight,
      };
    }
    try {
      const mp = document.getElementById('movie_player');
      if (mp && mp.getStatsForNerds) {
        const st = mp.getStatsForNerds();
        out.stats = { codecs: st.codecs, resolution: st.resolution };
        const s = (st.codecs || '').toLowerCase();
        out.codec = s.includes('av01') ? 'AV1' : s.includes('vp9') || s.includes('vp09') ? 'VP9' : s.includes('avc1') ? 'H.264' : 'unknown';
      }
    } catch {
      /* private API changed — overlay just shows what it can */
    }
    return out;
  }

  // Messaging with the isolated bridge (same window, different JS world).
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__bravePerf == null) return;
    if (e.data.__bravePerf === 'cfg') {
      Object.assign(cfg, e.data.cfg || {});
    } else if (e.data.__bravePerf === 'get-stats') {
      window.postMessage({ __bravePerf: 'stats', stats: readStats() }, '*');
    }
  });
})();
