/**
 * The core primitive both features depend on.
 *
 * Some retailers (Walmart most aggressively) reject plain fetch() but serve a
 * real browser fine. The distinction is not the HTTP request — an extension's
 * fetch already carries Chrome's own TLS fingerprint — it's that the anti-bot
 * layer wants to see its JavaScript challenge actually execute. So we let a
 * real tab load the page, then read the result out of it.
 *
 * Everything here exists to keep that invisible and bounded:
 *   - one reused minimised, unfocused window, so the user's tab strip is clean
 *   - a hard timeout, so a hanging page can't wedge the extension
 *   - a concurrency cap, so we never open a swarm of tabs
 *   - tabs closed in a finally, so a thrown error can't leak them
 */

const WINDOW_TITLE_MARKER = 'better-half-worker';
const DEFAULT_TIMEOUT_MS = 12000;
const MAX_CONCURRENT = 3;

let workerWindowId = null;
let active = 0;
const queue = [];

/**
 * A minimised popup window is the tidiest place to do this work, but it is not
 * available on every platform — `type: 'popup'` combined with
 * `state: 'minimized'` is rejected in some Chrome builds. If that fails we fall
 * back to an unfocused tab in the current window: slightly visible, but working
 * beats invisible-and-broken.
 *
 * Returns null when no worker window could be made, meaning "use the caller's
 * current window".
 */
async function getWorkerWindow() {
  if (workerWindowId != null) {
    try {
      await chrome.windows.get(workerWindowId);
      return workerWindowId;
    } catch {
      workerWindowId = null; // user closed it
    }
  }
  try {
    const win = await chrome.windows.create({
      url: 'about:blank',
      state: 'minimized',
      focused: false,
      type: 'popup',
    });
    workerWindowId = win.id;
    return workerWindowId;
  } catch (e) {
    console.debug('[better-half] minimised worker window unavailable', e);
  }
  try {
    const win = await chrome.windows.create({ url: 'about:blank', focused: false });
    workerWindowId = win.id;
    return workerWindowId;
  } catch (e) {
    console.debug('[better-half] no worker window at all; using current', e);
    return null;
  }
}

/**
 * Wait for a concurrency slot, but never forever. An unbounded queue here was
 * one way the whole comparison could hang with no timeout above it, leaving the
 * user staring at a spinner.
 */
function acquireSlot(timeoutMs = 15000) {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const entry = { resolve: null };
    const timer = setTimeout(() => {
      const i = queue.indexOf(entry);
      if (i !== -1) queue.splice(i, 1);
      reject(new Error('harvest queue timed out'));
    }, timeoutMs);
    entry.resolve = () => { clearTimeout(timer); resolve(); };
    queue.push(entry);
  });
}

function releaseSlot() {
  active -= 1;
  const next = queue.shift();
  if (next) {
    active += 1;
    next.resolve();
    return;
  }
  scheduleWorkerWindowCleanup();
}

/**
 * Close the worker window once the work is done.
 *
 * It used to be created and never closed, so an empty `about:blank` window sat
 * on the user's desktop after every comparison. The short delay avoids
 * thrashing it open and shut between back-to-back harvests.
 */
let cleanupTimer = null;
function scheduleWorkerWindowCleanup() {
  clearTimeout(cleanupTimer);
  cleanupTimer = setTimeout(() => {
    if (active === 0 && queue.length === 0) shutdownWorkerWindow();
  }, 3000);
}

/**
 * Load `url` in a background tab and run `extractor` inside it.
 *
 * @param {string} url
 * @param {Function} extractor  serialisable function, runs in the page
 * @param {object}  [opts]      { timeoutMs, args }
 * @returns {Promise<any>} whatever the extractor returned
 */
export async function harvest(url, extractor, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  await acquireSlot();

  let tabId = null;
  try {
    const windowId = await getWorkerWindow();
    const tab = await chrome.tabs.create(
      windowId != null ? { url, windowId, active: false } : { url, active: false },
    );
    tabId = tab.id;

    await waitForComplete(tabId, timeoutMs);

    // executeScript can hang if the page navigates mid-injection, so it gets
    // its own deadline rather than relying on the page-load timeout alone.
    const [result] = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId },
        func: extractor,
        args: opts.args ?? [],
        world: 'MAIN',
      }),
      timeoutMs,
      'extractor timed out',
    );
    return result?.result ?? null;
  } finally {
    if (tabId != null) {
      try { await chrome.tabs.remove(tabId); } catch { /* already gone */ }
    }
    releaseSlot();
  }
}

function waitForComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      fn(arg);
    };

    const timer = setTimeout(
      () => finish(reject, new Error(`harvest timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );

    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        // Give client-side rendering a beat to populate the DOM.
        setTimeout(() => finish(resolve), 600);
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);

    chrome.tabs.get(tabId).then((t) => {
      if (t.status === 'complete') setTimeout(() => finish(resolve), 600);
    }).catch(() => finish(reject, new Error('tab disappeared')));
  });
}

/**
 * Reject a promise that takes too long.
 * Every await in this file is bounded by one of these — an unbounded await
 * anywhere becomes a permanent spinner in the user's face.
 */
export function withTimeout(promise, ms, message = 'timed out') {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

/**
 * Plain JSON fetch, for hosts that don't fight us (Target's redsky, Shopify's
 * product endpoints). Much cheaper than a tab — always prefer it when it works.
 */
export async function fetchJson(url, { timeoutMs = 8000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Close the worker window, e.g. when the user disables the feature. */
export async function shutdownWorkerWindow() {
  if (workerWindowId == null) return;
  try { await chrome.windows.remove(workerWindowId); } catch { /* noop */ }
  workerWindowId = null;
}
