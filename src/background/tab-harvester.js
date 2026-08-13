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
 *   - one reused window, opened on the first harvest URL then hidden, so there
 *     is no placeholder tab and the user's tab strip stays clean
 *   - a hard timeout, so a hanging page can't wedge the extension
 *   - a concurrency cap, so we never open a swarm of tabs
 *   - tabs closed in a finally, so a thrown error can't leak them
 *   - a sweep at worker startup, because MV3 kills the worker and that finally
 *     with it
 */

const WINDOW_TITLE_MARKER = 'better-half-worker';
const DEFAULT_TIMEOUT_MS = 12000;
const MAX_CONCURRENT = 3;
const WORKER_WINDOW_KEY = 'harvestWorkerWindowId';

/**
 * Budgets for getting a worker window ready.
 *
 * These exist because v0.3.7 shipped without them and both tab-based retailers
 * stopped returning anything: Walmart and Home Depot each ran past the 22s
 * per-adapter timeout without their own 15s/20s harvest timeouts ever firing,
 * which can only happen if the stall is *before* the timed section — i.e. in
 * here. `chrome.windows.update({state:'minimized'})` appears to hang on macOS
 * rather than reject, and a try/catch cannot save you from a promise that never
 * settles.
 *
 * Hiding the window is a nicety. Harvesting is the product. Nothing here may
 * ever cost more than a couple of seconds, and a failure to hide must still
 * return a usable window.
 */
const HIDE_STEP_TIMEOUT_MS = 1200;
const WINDOW_SETUP_TIMEOUT_MS = 5000;
const SWEEP_TIMEOUT_MS = 2000;

let workerWindowId = null;
let active = 0;
const queue = [];

/**
 * Tabs we opened ourselves.
 *
 * The coupon content script matches every https page, so it also loads inside
 * these tabs. Without this set, harvesting an aggregator page made that page look
 * like a checkout, which kicked off a harvest for the aggregator's own domain,
 * which opened another tab, and so on — an unbounded loop of tabs opening and
 * closing while the user was nowhere near a store.
 */
const harvestTabIds = new Set();

/** Is this tab one of ours? Content scripts must do nothing inside them. */
export function isHarvestTab(tabId) {
  return tabId != null && harvestTabIds.has(tabId);
}

/**
 * Hide a window that already exists.
 *
 * Creating it hidden does not work: `state: 'minimized'` passed to
 * `windows.create` is rejected on macOS (combined with `type: 'popup'` it is
 * rejected outright), which is how every harvest ended up in a plain visible
 * `about:blank` window blinking on the user's desktop. Minimising a window that
 * already exists is supported everywhere, so we create first and hide second.
 *
 * Off-screen is the fallback rather than the primary: macOS clamps window
 * bounds towards the visible screen, so it hides the window on some setups and
 * merely shoves it into a corner on others.
 */
async function hideWindow(id) {
  try {
    await withTimeout(
      chrome.windows.update(id, { state: 'minimized' }),
      HIDE_STEP_TIMEOUT_MS,
      'minimise hung',
    );
    return true;
  } catch (e) {
    console.debug('[better-half] could not minimise worker window', e);
  }
  try {
    await withTimeout(
      chrome.windows.update(id, { left: -2000, top: -2000 }),
      HIDE_STEP_TIMEOUT_MS,
      'off-screen move hung',
    );
    return true;
  } catch (e) {
    console.debug('[better-half] could not move worker window off-screen', e);
    return false;
  }
}

/**
 * Where the worker window id lives between service worker lifetimes.
 *
 * `session`, deliberately, and this is a safety property rather than a
 * preference. Window ids are only unique within a browser session; after a
 * restart Chrome's counter starts over and an old id can name one of the user's
 * real windows. `storage.session` survives the worker being killed — the case
 * the sweep below exists for — and is wiped when the browser closes, which is
 * exactly the case where acting on a remembered id would close someone's work.
 *
 * Returns null where it isn't available (notably the Node shim used to import
 * this module in tests), which degrades to the old in-memory-only behaviour
 * rather than throwing at import time and taking the worker down with it.
 *
 * `globalThis.chrome`, not bare `chrome`: optional chaining only guards a
 * declared identifier against being null. Where `chrome` is not declared at all
 * — any plain Node import of this module — `chrome?.` still throws a
 * ReferenceError, and since this runs at module evaluation that throw fails the
 * entire service worker registration.
 */
function sessionStore() {
  return globalThis.chrome?.storage?.session ?? null;
}

async function rememberWorkerWindow(id) {
  workerWindowId = id;
  const store = sessionStore();
  if (!store) return;
  try {
    await store.set({ [WORKER_WINDOW_KEY]: id });
  } catch (e) {
    console.debug('[better-half] could not persist worker window id', e);
  }
}

async function forgetWorkerWindow() {
  workerWindowId = null;
  const store = sessionStore();
  if (!store) return;
  try {
    await store.remove(WORKER_WINDOW_KEY);
  } catch (e) {
    console.debug('[better-half] could not clear worker window id', e);
  }
}

/**
 * Close a worker window stranded by a previous service worker.
 *
 * `harvest()` closes its tab in a `finally`, which is enough for a thrown error
 * but not for MV3: the worker is terminated after ~30s idle and the `finally`
 * dies with it, leaving the tab — and the window holding it — open. Observed
 * live as leftover CouponFollow tabs.
 *
 * This runs once per worker startup, which is what module evaluation means
 * here. Nothing of ours can be in flight at that point (a fresh worker has no
 * harvests), so anything still recorded is by definition abandoned.
 *
 * Never rejects: an unhandled rejection during module evaluation fails the
 * whole service worker registration, which would cost the extension entirely to
 * clean up one stray window.
 */
export async function sweepStaleWorkerWindow() {
  const store = sessionStore();
  if (!store) return null;

  let stale = null;
  try {
    const stored = await store.get(WORKER_WINDOW_KEY);
    stale = stored?.[WORKER_WINDOW_KEY] ?? null;
  } catch (e) {
    console.debug('[better-half] could not read stale worker window id', e);
    return null;
  }
  if (stale == null) return null;

  try {
    await chrome.windows.remove(stale);
    console.debug('[better-half] swept stale worker window', stale);
  } catch {
    /* already gone — the id is stale either way, fall through and clear it */
  }
  try {
    await store.remove(WORKER_WINDOW_KEY);
  } catch (e) {
    console.debug('[better-half] could not clear stale worker window id', e);
  }
  return stale;
}

/**
 * Kicked off at module evaluation — i.e. once per service worker startup.
 * `getWorkerWindow()` awaits it before creating anything, so a sweep still in
 * flight can never remove a window we just opened.
 */
const staleSweep = sweepStaleWorkerWindow();

/**
 * One reused window that harvest tabs live in, kept out of the user's way.
 *
 * Deliberately `type: 'normal'` (the default): `tabs.create({ windowId })` into
 * a popup window is not reliable, and a popup has no tab strip to keep clean in
 * the first place.
 *
 * The first URL is loaded as the window's initial tab. Creating an
 * `about:blank` window and then adding the harvest tab leaves that blank tab
 * behind (and makes it visible whenever macOS refuses to hide the window).
 *
 * Returns null when no worker window could be made, meaning "use the caller's
 * current window" — visible, but working beats invisible-and-broken. Otherwise
 * returns the window id and, for a newly created window, its initial tab.
 */
async function getWorkerWindow(firstUrl) {
  if (workerWindowId != null) {
    try {
      await withTimeout(
        chrome.windows.get(workerWindowId),
        HIDE_STEP_TIMEOUT_MS,
        'window lookup hung',
      );
      return { windowId: workerWindowId, initialTab: null };
    } catch {
      // Closed by the user, or the API stopped answering. Either way this id is
      // no longer usable; falling through to make a fresh one beats waiting.
      await withTimeout(forgetWorkerWindow(), HIDE_STEP_TIMEOUT_MS, 'forget hung')
        .catch(() => { workerWindowId = null; });
    }
  }
  await withTimeout(staleSweep, SWEEP_TIMEOUT_MS, 'sweep hung').catch(() => {});
  try {
    return await withTimeout(
      createWorkerWindow(firstUrl),
      WINDOW_SETUP_TIMEOUT_MS,
      'worker window setup hung',
    );
  } catch (e) {
    console.debug('[better-half] no worker window; using current', e);
    return null;
  }
}

/**
 * The id is recorded *before* we try to hide the window, deliberately. If
 * hiding hangs past the budget above, the window still exists — recording it
 * first is what lets the cleanup and the startup sweep find it later, instead
 * of stranding exactly the kind of window this file exists to avoid.
 */
async function createWorkerWindow(firstUrl) {
  const win = await chrome.windows.create({
    url: firstUrl,
    focused: false,
    width: 500,
    height: 400,
  });
  await rememberWorkerWindow(win.id);

  // `Window.tabs` is optional in Chrome's API. Querying the new window keeps
  // this path correct when create() omits it: we reuse the real first tab
  // rather than adding a duplicate and leaving the original behind.
  const initialTab = win.tabs?.[0] ?? (await withTimeout(
    chrome.tabs.query({ windowId: win.id }),
    HIDE_STEP_TIMEOUT_MS,
    'initial tab lookup hung',
  ))[0];
  if (initialTab?.id == null) throw new Error('worker window has no initial tab');

  // Mark it before hiding the window. The URL is already loading, so its
  // content script must know immediately that this is one of our own tabs.
  harvestTabIds.add(initialTab.id);
  await hideWindow(win.id);
  return { windowId: workerWindowId, initialTab };
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
    const worker = await getWorkerWindow(url);
    const tab = worker?.initialTab ?? await chrome.tabs.create(
      worker != null
        ? { url, windowId: worker.windowId, active: false }
        : { url, active: false },
    );
    tabId = tab.id;
    harvestTabIds.add(tabId);

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
      harvestTabIds.delete(tabId);
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
 * Not worth opening a tab for less than this. A harvest that starts with three
 * seconds left cannot load a retail page; it just guarantees a timeout instead
 * of an honest "nothing found".
 */
export const MIN_USEFUL_MS = 4000;

/**
 * How long a harvest may run if the whole adapter must answer by `deadline`.
 *
 * Adapters here are two-phase: try the exact identifier (barcode, model
 * number), fall back to keywords. Each phase used to carry its own fixed cap,
 * which meant two phases could bill 15s + 15s against a 22s budget and blow it
 * without either phase's own timer firing. Measured live: Walmart timed out at
 * 22002ms while both its 15s harvests stayed comfortably inside their limits.
 *
 * A deadline is shared, so phases cannot stack past it. Returns null when too
 * little time remains to bother — the caller should give up with what it has
 * rather than start something that cannot finish.
 */
export function budgetFor(deadline, cap) {
  if (deadline == null) return cap; // no budget set: keep the old behaviour
  const remaining = deadline - Date.now();
  if (remaining < MIN_USEFUL_MS) return null;
  return Math.min(cap, remaining);
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
  await forgetWorkerWindow();
}

export const __test__ = { WORKER_WINDOW_KEY, sweepStaleWorkerWindow };
