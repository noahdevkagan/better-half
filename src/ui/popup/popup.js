/* global chrome */
/** Popup: settings, running savings total, and the proven-code ledger. */

const KEY_CODES = 'sd.codes.v1';
const KEY_SETTINGS = 'sd.settings.v1';
const KEY_SAVINGS = 'sd.savings.v1';

const DEFAULTS = {
  zip: null,
  storeId: '3991',
  prime: true,
  redcard: false,
  comparisonEnabled: true,
  couponsEnabled: true,
};

const TOGGLES = ['comparisonEnabled', 'couponsEnabled', 'prime', 'redcard'];

async function load() {
  // Read from the manifest Chrome actually loaded, so this can never disagree
  // with the running build — which is the whole point of showing it.
  document.getElementById('version').textContent = `v${chrome.runtime.getManifest().version}`;

  const store = await chrome.storage.local.get([KEY_SETTINGS, KEY_SAVINGS, KEY_CODES]);
  const settings = { ...DEFAULTS, ...(store[KEY_SETTINGS] || {}) };
  const savings = store[KEY_SAVINGS] || { total: 0 };
  const codes = Object.values(store[KEY_CODES] || {});

  document.getElementById('savings-total').textContent = `$${Number(savings.total || 0).toFixed(2)}`;

  for (const id of TOGGLES) {
    const el = document.getElementById(id);
    el.checked = settings[id] !== false;
    el.addEventListener('change', () => save({ [id]: el.checked }));
  }

  const zip = document.getElementById('zip');
  zip.value = settings.zip || '';
  zip.addEventListener('change', () => {
    const v = zip.value.replace(/\D/g, '').slice(0, 5);
    zip.value = v;
    save({ zip: v || null });
  });

  renderCodes(codes);
  wireDiagnostics();
}

/**
 * Retailer self-test.
 * Exists because "could not reach other retailers" is unactionable on its own —
 * this names the retailer, the reason, and how long it took before giving up.
 */
function wireDiagnostics() {
  const btn = document.getElementById('diag-run');
  const list = document.getElementById('diag-results');

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Testing…';
    list.replaceChildren();

    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'DIAGNOSE' });
    } catch (e) {
      res = { error: `background did not respond (${e?.message || e})` };
    }

    btn.disabled = false;
    btn.textContent = 'Test retailer connections';

    if (!res || res.error) {
      const li = document.createElement('li');
      li.className = 'bad';
      li.textContent = res?.error || 'No response from the background service worker.';
      list.appendChild(li);
      return;
    }

    for (const r of res.results) {
      const li = document.createElement('li');
      li.className = r.ok ? 'good' : 'bad';

      const name = document.createElement('span');
      name.className = 'diag-name';
      name.textContent = r.name;

      const detail = document.createElement('span');
      detail.className = 'diag-detail';
      detail.textContent = r.ok
        ? `${r.count} result${r.count === 1 ? '' : 's'} · ${r.ms}ms`
        : `${r.reason} · ${r.ms}ms`;

      li.append(name, detail);
      list.appendChild(li);
    }
  });
}

function renderCodes(codes) {
  const list = document.getElementById('codes-list');
  const empty = document.getElementById('codes-empty');

  const proven = codes
    .filter((c) => c.outcome === 'SUCCESS' || c.outcome === 'REJECTED')
    .sort((a, b) => (b.lastTestedAt || 0) - (a.lastTestedAt || 0))
    .slice(0, 40);

  if (!proven.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  for (const c of proven) {
    const li = document.createElement('li');
    if (c.outcome !== 'SUCCESS') li.className = 'dead';

    const code = document.createElement('span');
    code.className = 'code';
    code.textContent = c.code;

    const site = document.createElement('span');
    site.className = 'site';
    site.textContent = c.domain;

    const pct = document.createElement('span');
    pct.className = 'pct';
    pct.textContent = c.outcome === 'SUCCESS'
      ? (c.discountPct ? `${c.discountPct}%` : 'worked')
      : 'dead';

    li.append(code, site, pct);
    list.appendChild(li);
  }
}

async function save(patch) {
  const store = await chrome.storage.local.get(KEY_SETTINGS);
  const next = { ...DEFAULTS, ...(store[KEY_SETTINGS] || {}), ...patch };
  await chrome.storage.local.set({ [KEY_SETTINGS]: next });
}

load();
