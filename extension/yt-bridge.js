// Isolated-world content script on YouTube. Bridges chrome.* APIs (which the MAIN
// world can't use) to the page world via window.postMessage + a shared localStorage
// mirror that lets yt-codec.js read config synchronously on the next page load.

const KEY = 'bravePerfCodec';
const LS_KEY = '__bravePerfCodec';
const DEFAULT = { blockAV1: false, blockVP9: false, blockVP8: false };

function push(cfg) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(cfg));
  } catch {
    /* storage blocked — live postMessage below still updates this session */
  }
  window.postMessage({ __bravePerf: 'cfg', cfg }, '*');
}

// On load: mirror stored config into the page and localStorage.
chrome.storage.local.get([KEY]).then((res) => push({ ...DEFAULT, ...(res[KEY] || {}) }));

// Live updates when the popup changes settings.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[KEY]) push({ ...DEFAULT, ...(changes[KEY].newValue || {}) });
});

// Relay a stats request from the popup to the MAIN world and back.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'get-yt-stats') {
    const handler = (e) => {
      if (e.source !== window || !e.data || e.data.__bravePerf !== 'stats') return;
      window.removeEventListener('message', handler);
      sendResponse(e.data.stats);
    };
    window.addEventListener('message', handler);
    window.postMessage({ __bravePerf: 'get-stats' }, '*');
    return true; // keep the channel open for the async response
  }
  return false;
});
