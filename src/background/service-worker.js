/**
 * Orchestration. Content scripts extract and render; all matching, network
 * access and scoring happens here.
 */

import { normalizeQuantity, unitPrice } from '../match/normalize.js';
import { matchConfidence, buildVerdict, TIER } from '../match/confidence.js';
import * as target from '../adapters/target.js';
import * as walmart from '../adapters/walmart.js';
import * as homedepot from '../adapters/homedepot.js';
import * as costco from '../adapters/costco.js';
import * as ledger from '../ledger/store.js';
import * as couponSources from './coupon-sources.js';
import { checkAmazonPurchases } from './amazon-price.js';
import { withTimeout, isHarvestTab } from './tab-harvester.js';

// Target answers plain fetch() in milliseconds. Walmart and Home Depot need a
// harvested tab, and Walmart may be blocked outright, so no adapter is allowed
// to gate the result — they run concurrently and failures are dropped.
const BASE_ADAPTERS = [target, walmart, homedepot];

async function adaptersFor(settings) {
  if (!settings.costcoEnabled || !globalThis.chrome?.permissions?.contains) return BASE_ADAPTERS;
  const granted = await chrome.permissions.contains({ origins: ['https://www.costco.com/*'] });
  return granted ? [...BASE_ADAPTERS, costco] : BASE_ADAPTERS;
}

/**
 * Hard ceiling per retailer. Tab-based adapters can stall on a slow page, a
 * bot challenge that never resolves, or a renderer that never fires
 * `complete` — and one stalled adapter used to hang the entire comparison,
 * leaving the card spinning "Checking other retailers…" indefinitely.
 */
/**
 * How long any one retailer gets.
 *
 * Raised from 22s after measuring in real Chrome rather than the Electron
 * preview these numbers were first tuned in: Target answered in 3525ms against
 * the ~1.1s recorded in HANDOFF, and Home Depot needed 18859ms for a single
 * harvest. Everything tab-based is roughly 3x slower here, and 22s left Home
 * Depot passing with about a second to spare.
 *
 * The adapters now also receive this as a `deadline` and stop starting work
 * they cannot finish, so this is a backstop rather than the primary control —
 * a retailer should return "no match" on its own before this ever fires.
 */
const ADAPTER_TIMEOUT_MS = 30000;

/** Left for the caller to assemble a card once the adapters report back. */
const DEADLINE_MARGIN_MS = 1500;

/** Amazon ships free for Prime members, which we assume by default. */
const AMAZON_SHIPPING = { freeShippingThreshold: 35, flatShipping: 0 };

function amazonShipping(subtotal, settings) {
  if (settings.prime !== false) return 0;
  return subtotal >= AMAZON_SHIPPING.freeShippingThreshold ? 0 : 5.99;
}

function quantityLabel(q) {
  if (!q) return '';
  return q.count > 1
    ? `${q.each}${q.unitLabel} × ${q.count}`
    : `${q.total}${q.unitLabel}`;
}

async function compare(product) {
  const settings = await ledger.getSettings();
  const adapters = await adaptersFor(settings);

  const sourceQuantity = normalizeQuantity(product.title, product.structured || {});
  const source = {
    title: product.title,
    barcode: product.barcode,
    model: product.model,
    brand: product.brand,
    quantity: sourceQuantity,
    inStock: product.inStock,
    total: product.price == null
      ? null
      : round2(product.price + amazonShipping(product.price, settings)),
    // Needed for the unit-price path, which is the common case whenever
    // retailers stock different pack sizes of the same product.
    unitPrice: unitPrice(product.price, sourceQuantity),
  };

  // Rank candidates for the limited PDP budget. We deliberately do NOT reject
  // here: search results carry no barcode, so a candidate can only reach tier 1
  // after enrichment supplies one. Filtering happens after enrichment.
  const preselect = (candidates) => [...candidates]
    .sort((a, b) => scoreForShortlist(b, source) - scoreForShortlist(a, source));

  // Run adapters concurrently. One retailer being slow or blocked must never
  // hold up or invalidate the others.
  const deadline = Date.now() + ADAPTER_TIMEOUT_MS - DEADLINE_MARGIN_MS;
  const settled = await Promise.allSettled(
    adapters.map((a) => withTimeout(
      a.lookup(source, { preselect, storeId: settings.storeId, deadline }),
      ADAPTER_TIMEOUT_MS,
      `${a.RETAILER?.id ?? 'adapter'}: timed out`,
    )),
  );

  const found = [];
  // Track what actually happened so the card can say "checked X, Y, Z" instead
  // of silently vanishing — a card that disappears is indistinguishable from a
  // crash, and tells the user nothing about whether it even looked.
  const checked = [];
  const failed = [];
  let examined = 0;

  settled.forEach((res, i) => {
    const adapter = adapters[i];
    if (res.status === 'rejected') {
      // Keep the REASON, not just the name. "Could not reach Target" is
      // undiagnosable; "Target: rate-limited, retrying in 40s" is actionable,
      // and it is the only signal available to someone who can't open the
      // service-worker console.
      failed.push({
        name: adapter.RETAILER?.name ?? 'unknown',
        reason: String(res.reason?.message || res.reason || 'unknown error')
          .replace(/^\w+:\s*/, '')
          .slice(0, 90),
      });
      console.debug('[better-half] adapter failed', adapter.RETAILER?.id, res.reason);
      return;
    }
    checked.push(adapter.RETAILER?.name ?? 'unknown');
    examined += res.value.length;
    for (const c of res.value) {
      const m = matchConfidence(source, c);
      if (m.tier === TIER.REJECT) continue;
      // A range price (e.g. "$399.00 - $499.00" across variants) has no single
      // total and must never become a saving claim.
      const hasPrice = c.price != null;
      // What the retailer's own page says always beats our threshold table.
      // That table has already been wrong once, pricing $8.99 of shipping onto
      // a $44.99 item whose page read "FREE delivery" — enough to flip the
      // verdict to the wrong retailer.
      const shipping = hasPrice
        ? adapter.shippingFor(c.price, settings, c.scrapedShipping)
        : null;
      found.push({
        ...c,
        tier: m.tier,
        reasons: m.reasons,
        variantNote: m.variantNote || null,
        brandNote: m.brandNote || null,
        aftermarket: m.aftermarket || false,
        shipping,
        // A retailer with unknown shipping cannot support a true-total claim.
        // Costco uses this path when its page does not state whether shipping
        // is included; silence beats an invented saving.
        total: hasPrice && shipping != null ? round2(c.price + shipping) : null,
        unitPrice: hasPrice ? unitPrice(c.price, c.quantity) : null,
        unitLabel: c.quantity?.unitLabel,
        quantityLabel: quantityLabel(c.quantity),
      });
    }
  });

  const verdict = buildVerdict(source, found);

  if (verdict.saving > 0 && verdict.verdict === 'CHEAPER_ELSEWHERE') {
    await ledger.recordSaving(verdict.saving, 'comparison');
  }

  return {
    ...verdict,
    checked,
    failed,
    examined,
    sourceUnitPrice: unitPrice(product.price, sourceQuantity),
    sourceQuantityLabel: quantityLabel(sourceQuantity),
    sourceUnitLabel: sourceQuantity?.unitLabel,
  };
}

/**
 * Rank candidates for the limited PDP budget. Size proximity is the strongest
 * cheap signal available before we have barcodes.
 */
function scoreForShortlist(c, source) {
  if (!c.quantity || !source.quantity) return 0;
  if (c.quantity.family !== source.quantity.family) return -1;
  const a = c.quantity.total;
  const b = source.quantity.total;
  if (!a || !b) return 0;
  return 1 - Math.abs(a - b) / Math.max(a, b);
}

function round2(n) {
  return n == null ? null : Math.round(n * 100) / 100;
}

/**
 * Self-test, surfaced as a button in the popup.
 *
 * "Could not reach other retailers" is a dead end for anyone who can't open the
 * service-worker console. This runs a known-good product through each adapter
 * and reports, per retailer, whether it answered and how long it took — turning
 * an opaque failure into something you can read and act on.
 */
async function diagnose() {
  const settings = await ledger.getSettings();
  const adapters = await adaptersFor(settings);
  const probe = {
    title: 'Similac 360 Total Care Sensitive Infant Formula 30.2oz',
    barcode: '070074681238',
    model: null,
    brand: 'Similac',
    quantity: normalizeQuantity('Similac 360 Total Care Sensitive Infant Formula 30.2oz'),
    inStock: true,
    total: 54.99,
    unitPrice: null,
  };

  const results = await Promise.all(adapters.map(async (a) => {
    const name = a.RETAILER?.name ?? 'unknown';
    const started = Date.now();
    try {
      const found = await withTimeout(
        a.lookup(probe, { deadline: started + ADAPTER_TIMEOUT_MS - DEADLINE_MARGIN_MS }),
        ADAPTER_TIMEOUT_MS,
        'timed out',
      );
      return { name, ok: true, count: found.length, ms: Date.now() - started };
    } catch (e) {
      return {
        name,
        ok: false,
        ms: Date.now() - started,
        reason: String(e?.message || e).replace(/^\w+:\s*/, '').slice(0, 100),
      };
    }
  }));

  return { results, at: Date.now() };
}

// ------------------------------------------------------------- messaging --

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'COMPARE') {
    compare(msg.product)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: String(e?.message || e) }));
    return true; // async
  }

  if (msg?.type === 'CHECK_AMAZON_PURCHASES') {
    checkAmazonPurchases(msg.items)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: String(e?.message || e) }));
    return true;
  }

  if (msg?.type === 'COUPON_RESULTS') {
    ledger.recordCouponResults(msg.domain, msg.results)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg?.type === 'GET_CODES') {
    // A harvest tab asking for codes means the coupon flow started inside our
    // own scrape. Nothing good comes of answering it.
    if (isHarvestTab(sender.tab?.id)) {
      sendResponse({ codes: [], candidates: [] });
      return false;
    }

    // Proven codes come from local storage instantly; aggregator codes need a
    // harvested tab. Run both and merge, so a slow/blocked aggregator can never
    // delay the codes we already trust.
    Promise.allSettled([
      ledger.getCodesFor(msg.domain, { subtotal: msg.subtotal }),
      couponSources.fetchCandidates(msg.domain),
    ]).then(([known, fetched]) => {
      sendResponse({
        codes: known.status === 'fulfilled' ? known.value.codes : [],
        candidates: fetched.status === 'fulfilled' ? fetched.value : [],
      });
    });
    return true;
  }

  if (msg?.type === 'GET_SETTINGS') {
    // `harvestTab` is per-caller, not a stored setting — it tells a content
    // script whether it is running inside a tab we opened.
    const harvestTab = isHarvestTab(sender.tab?.id);
    ledger.getSettings().then((s) => sendResponse({ ...s, harvestTab }));
    return true;
  }

  if (msg?.type === 'DIAGNOSE') {
    diagnose().then(sendResponse).catch((e) => sendResponse({ error: String(e?.message || e) }));
    return true;
  }

  return false;
});
