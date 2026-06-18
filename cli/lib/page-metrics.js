// Expressions injected into the page via Runtime.evaluate.
// These run in the page MAIN world, so they can see web APIs and (on YouTube) the player.

// Installs PerformanceObservers as early as possible and stashes results on window.
// Call this right after navigation starts so we don't miss LCP/CLS entries.
export const INSTALL_VITALS = `
(() => {
  if (window.__bravePerf) return 'already';
  const s = { lcp: null, cls: 0, inp: 0, fcp: null, longTasks: 0, longTaskMs: 0 };
  window.__bravePerf = s;
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) s.lcp = e.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {}
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (!e.hadRecentInput) s.cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {}
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) s.inp = Math.max(s.inp, e.duration);
    }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
  } catch {}
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') s.fcp = e.startTime;
    }).observe({ type: 'paint', buffered: true });
  } catch {}
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) { s.longTasks++; s.longTaskMs += e.duration; }
    }).observe({ type: 'longtask', buffered: true });
  } catch {}
  return 'installed';
})()
`;

// Reads everything back: vitals + navigation timing + JS heap.
export const READ_VITALS = `
(() => {
  const s = window.__bravePerf || {};
  const nav = performance.getEntriesByType('navigation')[0] || {};
  const mem = performance.memory || {};
  return {
    lcp: s.lcp, cls: s.cls, inp: s.inp || null, fcp: s.fcp,
    longTasks: s.longTasks || 0, longTaskMs: Math.round(s.longTaskMs || 0),
    ttfb: nav.responseStart || null,
    domContentLoaded: nav.domContentLoadedEventEnd || null,
    loadEvent: nav.loadEventEnd || null,
    transferSize: nav.transferSize || null,
    encodedBodySize: nav.encodedBodySize || null,
    resources: performance.getEntriesByType('resource').length,
    jsHeapUsed: mem.usedJSHeapSize || null,
    jsHeapLimit: mem.jsHeapSizeLimit || null,
  };
})()
`;

// YouTube-specific: dropped frames, active codec, and decode power-efficiency probe.
export const READ_YOUTUBE = `
(async () => {
  const out = { isYouTube: location.hostname.includes('youtube.com'), video: null, codec: null,
                stats: null, decode: {} };
  const v = document.querySelector('video');
  if (v && v.getVideoPlaybackQuality) {
    const q = v.getVideoPlaybackQuality();
    out.video = {
      total: q.totalVideoFrames, dropped: q.droppedVideoFrames,
      dropPct: q.totalVideoFrames ? +(q.droppedVideoFrames / q.totalVideoFrames * 100).toFixed(2) : 0,
      width: v.videoWidth, height: v.videoHeight, currentTime: +v.currentTime.toFixed(1), paused: v.paused,
    };
  }
  try {
    const mp = document.getElementById('movie_player');
    if (mp && mp.getStatsForNerds) {
      const st = mp.getStatsForNerds();
      out.stats = { codecs: st.codecs, resolution: st.resolution, fps: st.fps, bandwidth_kbps: st.bandwidth_kbps };
      const codecStr = (st.codecs || '').toLowerCase();
      out.codec = codecStr.includes('av01') ? 'AV1'
        : (codecStr.includes('vp09') || codecStr.includes('vp9')) ? 'VP9'
        : codecStr.includes('avc1') ? 'H.264' : 'unknown';
    }
  } catch {}
  // Power-efficiency probe: is each codec hardware (powerEfficient) on this machine?
  try {
    const probe = (contentType) => navigator.mediaCapabilities.decodingInfo({
      type: 'media-source',
      video: { contentType, width: 1920, height: 1080, bitrate: 5_000_000, framerate: 30 },
    });
    const [av1, vp9, h264] = await Promise.all([
      probe('video/mp4; codecs="av01.0.08M.08"'),
      probe('video/webm; codecs="vp09.00.40.08"'),
      probe('video/mp4; codecs="avc1.640028"'),
    ]);
    out.decode = {
      AV1: { supported: av1.supported, powerEfficient: av1.powerEfficient },
      VP9: { supported: vp9.supported, powerEfficient: vp9.powerEfficient },
      'H.264': { supported: h264.supported, powerEfficient: h264.powerEfficient },
    };
  } catch {}
  return out;
})()
`;
