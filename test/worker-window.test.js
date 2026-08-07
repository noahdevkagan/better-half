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
    tabs: { onUpdated: { addListener() {}, removeListener() {} } },
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
