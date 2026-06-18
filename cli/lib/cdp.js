// Minimal, zero-dependency Chrome DevTools Protocol client.
// Uses Node's built-in global fetch + WebSocket (Node >= 22), so no npm install needed.
//
// Flatten mode: a single browser-level WebSocket carries every session, routed by
// sessionId. Commands aimed at a page pass { sessionId }; events carry it back.

const RPC_TIMEOUT_MS = 30_000;

async function openSocket(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', (e) => reject(new Error('WebSocket error: ' + (e?.message || 'failed to connect'))), {
      once: true,
    });
  });
  return ws;
}

function makeClient(ws) {
  let nextId = 1;
  const pending = new Map(); // id -> {resolve, reject, timer}
  const listeners = new Map(); // method -> Set<cb(params, sessionId)>

  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id);
      clearTimeout(timer);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
    } else if (msg.method) {
      const set = listeners.get(msg.method);
      if (set) for (const cb of set) cb(msg.params, msg.sessionId);
    }
  });

  function send(method, params = {}, sessionId) {
    const id = nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, RPC_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify(payload));
    });
  }

  function on(method, cb) {
    if (!listeners.has(method)) listeners.set(method, new Set());
    listeners.get(method).add(cb);
    return () => listeners.get(method)?.delete(cb);
  }

  /** Resolve once `method` fires, optionally filtered by predicate. */
  function once(method, { sessionId, predicate, timeout = RPC_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeout);
      const off = on(method, (params, sid) => {
        if (sessionId && sid !== sessionId) return;
        if (predicate && !predicate(params)) return;
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }

  function close() {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }

  return { send, on, once, close, raw: ws };
}

/** Connect to the browser-level endpoint and return a flatten-mode client. */
export async function connectBrowser(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`);
  if (!res.ok) throw new Error(`Discovery failed: HTTP ${res.status}`);
  const info = await res.json();
  const ws = await openSocket(info.webSocketDebuggerUrl);
  const client = makeClient(ws);
  return { client, info };
}

/**
 * Create a fresh tab, attach to it, and return its sessionId + a cleanup fn.
 * Enables the common domains used for measurement.
 */
export async function openPage(client, url = 'about:blank') {
  const { targetId } = await client.send('Target.createTarget', { url });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  await client.send('Page.enable', {}, sessionId);
  await client.send('Runtime.enable', {}, sessionId);
  await client.send('Performance.enable', { timeDomain: 'timeTicks' }, sessionId).catch(() => {});
  await client.send('Network.enable', {}, sessionId).catch(() => {});
  const closeTab = () => client.send('Target.closeTarget', { targetId }).catch(() => {});
  return { sessionId, targetId, closeTab };
}

/** Evaluate an expression in the page's MAIN world and return the value. */
export async function evaluate(client, sessionId, expression, { awaitPromise = true } = {}) {
  const { result, exceptionDetails } = await client.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise },
    sessionId,
  );
  if (exceptionDetails) {
    throw new Error('Eval error: ' + (exceptionDetails.exception?.description || exceptionDetails.text));
  }
  return result.value;
}
