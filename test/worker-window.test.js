/**
 * Regression tests for leaked harvest windows.
 *
 * `harvest()` closes its tab in a `finally`, which covers a thrown error but
 * not the way MV3 actually ends things: the service worker is terminated after
 * ~30s idle and the `finally` never runs. Observed live as leftover
 * CouponFollow tabs sitting in a window the user never opened.
 *
 * The fix is a sweep at worker startup, so these tests care about one thing —
 * that the sweep closes exactly the window we abandoned, and nothing else.
 *
 * `chrome` is shimmed rather than mocked with a framework: the module reads a
 * handful of APIs, so a failure here should point at the sweep logic rather
 * than at a mock. Note the module is imported *fresh* per test (via a cache-
 * busting query string) because the sweep runs at module evaluation — that
 * timing is the behaviour under test, not an implementation detail.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const MODULE = '../src/background/tab-harvester.js';

// ------------------------------------------------------------ chrome shim --

/**
 * @param {object} opts
 *   session   - initial chrome.storage.session contents, or null to omit the
 *               area entirely (the case the Node import path in HANDOFF hits)
 *   openIds   - window ids that currently exist; removing anything else throws,
 *               the way chrome.windows.remove does for an unknown id
 */
function shimChrome({ session = {}, openIds = [] } = {}) {
  const store = { ...session };
  const open = new Set(openIds);
  const removed = [];

  globalThis.chrome = {
    runtime: { onMessage: { addListener() {} } },
    tabs: {
      onUpdated: { addListener() {}, removeListener() {} },
      async query({ windowId }) {
        return [{ id: windowId + 100, status: 'loading' }];
      },
    },
    windows: {
      async remove(id) {
        if (!open.has(id)) throw new Error(`No window with id: ${id}`);
        open.delete(id);
        removed.push(id);
      },
      async get(id) {
        if (!open.has(id)) throw new Error(`No window with id: ${id}`);
        return { id };
      },
      async create() {
        const id = 900 + open.size;
        open.add(id);
        return { id };
      },
      async update(id) {
        return { id };
      },
    },
    storage: {
      local: { async get() { return {}; }, async set() {}, async remove() {} },
      ...(session === null ? {} : {
        session: {
          async get(key) {
            return key in store ? { [key]: store[key] } : {};
          },
          async set(obj) { Object.assign(store, obj); },
          async remove(key) { delete store[key]; },
        },
      }),
    },
  };

  return { store, open, removed };
}

/** Import a fresh copy, so module-evaluation-time work runs again. */
let seq = 0;
async function freshImport() {
  seq += 1;
  return import(`${MODULE}?t=${seq}`);
}

// ------------------------------------------------------------------ tests --

test('a window stranded by a killed worker is closed at startup', async () => {
  const { removed, store } = shimChrome({
    session: { harvestWorkerWindowId: 42 },
    openIds: [42, 7],
  });

  const mod = await freshImport();
  await mod.__test__.sweepStaleWorkerWindow();

  assert.deepEqual(removed, [42], 'closed the abandoned window');
  assert.deepEqual(store, {}, 'and stopped remembering it');
});

test("the user's other windows are left alone", async () => {
  const { removed, open } = shimChrome({
    session: { harvestWorkerWindowId: 42 },
    openIds: [42, 7, 8],
  });

  const mod = await freshImport();
  await mod.__test__.sweepStaleWorkerWindow();

  assert.deepEqual([...open].sort(), [7, 8], 'only the worker window went');
  assert.equal(removed.length, 1);
});

test('nothing remembered means nothing is closed', async () => {
  const { removed } = shimChrome({ session: {}, openIds: [7] });

  const mod = await freshImport();
  const swept = await mod.__test__.sweepStaleWorkerWindow();

  assert.equal(swept, null);
  assert.deepEqual(removed, [], 'a clean shutdown leaves no work to do');
});

test('a remembered window the user already closed is forgotten, not retried', async () => {
  // The id outlived the window: the user closed it by hand before we woke up.
  const { removed, store } = shimChrome({
    session: { harvestWorkerWindowId: 42 },
    openIds: [7],
  });

  const mod = await freshImport();
  await mod.__test__.sweepStaleWorkerWindow(); // must not throw

  assert.deepEqual(removed, []);
  assert.deepEqual(store, {}, 'the dead id is cleared so it cannot be reused');
});

test('no storage.session at all degrades quietly instead of throwing', async () => {
  // The Node import path in HANDOFF.md shims only storage.local. Importing this
  // module must still work there — an import-time throw takes down the whole
  // service worker registration.
  const { removed } = shimChrome({ session: null, openIds: [7] });

  const mod = await freshImport();
  const swept = await mod.__test__.sweepStaleWorkerWindow();

  assert.equal(swept, null);
  assert.deepEqual(removed, [], 'no memory means no sweep, not a crash');
});

test('the sweep never rejects, even when storage itself fails', async () => {
  shimChrome({ session: {}, openIds: [] });
  globalThis.chrome.storage.session.get = async () => {
    throw new Error('storage unavailable');
  };

  const mod = await freshImport();
  await assert.doesNotReject(() => mod.__test__.sweepStaleWorkerWindow());
});

// ------------------------------------------------ shared adapter budget --

test('two search phases cannot bill more than the adapter budget', async () => {
  // Measured live in real Chrome: Walmart reported "timed out · 22002ms" while
  // both of its 15s harvests stayed inside their own limits. Two phases each
  // capped separately at 15s bill 30s against a 22s budget, and the per-phase
  // timers never fire because neither phase is individually late.
  shimChrome();
  const { budgetFor } = await freshImport();

  const deadline = Date.now() + 22000;
  const first = budgetFor(deadline, 15000);
  assert.equal(first, 15000, 'the first phase gets its full cap');

  // Pretend the first phase used all 15s.
  const afterFirst = budgetFor(deadline - 15000, 15000);
  assert.ok(afterFirst <= 7000, `second phase must fit what is left, got ${afterFirst}`);
  assert.ok(first + afterFirst <= 22000, 'the two phases together stay in budget');
});

test('a phase with no useful time left is skipped, not started', async () => {
  shimChrome();
  const { budgetFor, MIN_USEFUL_MS } = await freshImport();

  assert.equal(
    budgetFor(Date.now() + 500, 15000),
    null,
    'half a second cannot load a retail page — say so instead of timing out',
  );
  assert.ok(MIN_USEFUL_MS >= 1000, 'the floor should be a real page-load budget');
});

test('no deadline keeps the old fixed-cap behaviour', async () => {
  shimChrome();
  const { budgetFor } = await freshImport();

  assert.equal(budgetFor(null, 15000), 15000);
  assert.equal(budgetFor(undefined, 20000), 20000);
});

test('a hanging windows.update cannot stall the harvest', async () => {
  // v0.3.7 shipped this bug: `windows.update({state:'minimized'})` hangs on
  // macOS rather than rejecting, and getWorkerWindow awaited it unbounded. Both
  // tab-based retailers then blew past the 22s per-adapter timeout without
  // their own 15s/20s harvest timeouts ever firing — the tell that the stall
  // was before the timed section. A try/catch cannot save you from a promise
  // that never settles; only a timeout can.
  shimChrome({ session: {}, openIds: [] });
  globalThis.chrome.windows.update = () => new Promise(() => {}); // never settles

  const mod = await freshImport();

  const started = process.hrtime.bigint();
  // The tab never loads in the shim, so harvest rejects — the point is *when*.
  await mod.harvest('https://example.com', () => null, { timeoutMs: 50 })
    .catch(() => {});
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.ok(
    elapsedMs < 6000,
    `harvest should give up on hiding and get on with it, took ${Math.round(elapsedMs)}ms`,
  );
});

test('the first harvest URL replaces the blank worker-window placeholder', async () => {
  shimChrome({ session: {}, openIds: [] });

  const createdWindows = [];
  const createdTabs = [];
  const queriedTabs = [];
  globalThis.chrome.windows.create = async (options) => {
    createdWindows.push(options);
    return { id: 55 }; // Window.tabs is optional in Chrome's API.
  };
  globalThis.chrome.tabs.query = async (options) => {
    queriedTabs.push(options);
    return [{ id: 56, status: 'complete' }];
  };
  globalThis.chrome.tabs.create = async (options) => {
    createdTabs.push(options);
    return { id: 57, status: 'complete' };
  };
  globalThis.chrome.tabs.get = async () => ({ status: 'complete' });
  globalThis.chrome.tabs.remove = async () => {};
  globalThis.chrome.scripting = {
    async executeScript() { return [{ result: 'ok' }]; },
  };

  const mod = await freshImport();
  const url = 'https://www.walmart.com/search?q=helmet';
  const result = await mod.harvest(url, () => 'ok', { timeoutMs: 2000 });

  assert.equal(result, 'ok');
  assert.equal(createdWindows.length, 1);
  assert.equal(createdWindows[0].url, url, 'window opens on the real harvest URL');
  assert.deepEqual(queriedTabs, [{ windowId: 55 }], 'the initial real tab is reused');
  assert.deepEqual(createdTabs, [], 'no second tab or about:blank placeholder is created');

  await mod.shutdownWorkerWindow();
});

test('shutdownWorkerWindow clears the stored id, so the next startup is a no-op', async () => {
  const { store, removed } = shimChrome({ session: {}, openIds: [] });

  const mod = await freshImport();
  // Create a worker window the normal way, then tear it down.
  const id = await mod.__test__.sweepStaleWorkerWindow(); // drains startup sweep
  assert.equal(id, null);

  globalThis.chrome.windows.create = async () => {
    globalThis.chrome.windows.get = async () => ({ id: 55 });
    globalThis.chrome.windows.remove = async (rid) => { removed.push(rid); };
    return { id: 55 };
  };

  await mod.harvest('https://example.com', () => null, { timeoutMs: 1 })
    .catch(() => {}); // the tab never loads here; we only want the window created

  await mod.shutdownWorkerWindow();

  assert.equal(store.harvestWorkerWindowId, undefined, 'id no longer stored');
});
