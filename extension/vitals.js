// Isolated-world content script on every page. Collects Core Web Vitals from the
// page's performance timeline and answers the popup's "get-vitals" request.
// Read-only: it observes, it never changes the page.

(() => {
  const s = { lcp: null, cls: 0, inp: 0, fcp: null, longTasks: 0, longTaskMs: 0 };

  const obs = (type, cb, extra) => {
    try {
      new PerformanceObserver((l) => l.getEntries().forEach(cb)).observe({ type, buffered: true, ...extra });
    } catch {
      /* entry type unsupported in this context */
    }
  };

  obs('largest-contentful-paint', (e) => (s.lcp = e.startTime));
  obs('layout-shift', (e) => {
    if (!e.hadRecentInput) s.cls += e.value;
  });
  obs('event', (e) => (s.inp = Math.max(s.inp, e.duration)), { durationThreshold: 16 });
  obs('paint', (e) => {
    if (e.name === 'first-contentful-paint') s.fcp = e.startTime;
  });
  obs('longtask', (e) => {
    s.longTasks++;
    s.longTaskMs += e.duration;
  });

  function snapshot() {
    const nav = performance.getEntriesByType('navigation')[0] || {};
    const mem = performance.memory || {};
    return {
      url: location.href,
      lcp: s.lcp,
      cls: +s.cls.toFixed(3),
      inp: s.inp || null,
      fcp: s.fcp,
      ttfb: nav.responseStart || null,
      load: nav.loadEventEnd || null,
      longTasks: s.longTasks,
      longTaskMs: Math.round(s.longTaskMs),
      jsHeapUsed: mem.usedJSHeapSize || null,
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'get-vitals') {
      sendResponse(snapshot());
      return false;
    }
    return false;
  });
})();
