/**
 * Walmart adapter.
 *
 * UNPROVEN — this is the one spike the plan flagged as able to force a redesign.
 *
 * Walmart runs Akamai Bot Manager plus PerimeterX. Plain scrapers fail at the
 * TLS layer (JA3/JA4), which an extension does NOT have a problem with — its
 * requests are Chrome's. The remaining barrier is PerimeterX's JavaScript
 * challenge, which is why this adapter goes through `harvest()`: a real tab
 * runs the challenge, and we read the result afterwards.
 *
 * During design validation a preview browser hit "Robot or human?", but that
 * browser was Electron with a non-standard `Claude/...` user agent — not a fair
 * test of real Chrome. Verify in an unpacked extension before trusting this.
 * If it stays blocked, comparison falls back to Target-only, which still works.
 *
 * We parse Walmart's own `__NEXT_DATA__` JSON rather than rendered DOM, because
 * the JSON shape is far more stable than their markup.
 */

import { harvest, budgetFor } from '../background/tab-harvester.js';
import { decodeEntities, normalizeQuantity, parsePrice } from '../match/normalize.js';
import { buildKeyword } from '../match/keywords.js';

export { buildKeyword };

export const RETAILER = {
  id: 'walmart',
  name: 'Walmart',
  freeShippingThreshold: 35,
  flatShipping: 6.99,
};

export function shippingFor(subtotal, opts = {}, scraped) {
  if (scraped != null) return scraped;
  if (opts.walmartPlus) return 0;
  return subtotal >= RETAILER.freeShippingThreshold ? 0 : RETAILER.flatShipping;
}

/**
 * Runs INSIDE the harvested tab. Must be fully self-contained — no closures
 * over anything in this module.
 */
async function extractSearchResults() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { blocked: false, items: [] };

  if (/robot or human|verify your identity/i.test(document.body.innerText.slice(0, 2000))
      || /\/blocked/.test(location.pathname)) {
    out.blocked = true;
    return out;
  }

  // Titles and ids come from __NEXT_DATA__, which is reliable — but NOT prices.
  // Walmart server-renders every price field EMPTY (`itemPrice: ""`,
  // `minPrice: 0`, `price: 0`) and hydrates them client-side. Reading `price`
  // there yields 0 for every item, which then rendered as bare shipping cost
  // ($6.99) on the card. Prices must come from the DOM after hydration.
  const meta = new Map();
  const el = document.getElementById('__NEXT_DATA__');
  if (el) {
    try {
      const data = JSON.parse(el.textContent);
      const stacks = data?.props?.pageProps?.initialData?.searchResult?.itemStacks
        || data?.props?.pageProps?.initialData?.data?.search?.searchResult?.itemStacks
        || [];
      for (const stack of stacks) {
        for (const it of [...(stack?.itemsV2 || []), ...(stack?.items || [])]) {
          if (!it || it.__typename === 'AdPlacement') continue;
          const key = String(it.usItemId || it.id || '');
          if (key) {
            meta.set(key, {
              name: String(it.name || ''),
              upc: it.upc || null,
              url: it.canonicalUrl ? `https://www.walmart.com${it.canonicalUrl}` : null,
              outOfStock: it.availabilityStatusV2?.value === 'OUT_OF_STOCK'
                || it.availabilityStatus === 'OUT_OF_STOCK',
            });
          }
        }
      }
    } catch { /* DOM alone is enough */ }
  }

  let tiles = [];
  for (let i = 0; i < 15; i += 1) {
    tiles = [...document.querySelectorAll('[data-item-id]')];
    if (tiles.length) break;
    await sleep(400);
  }

  const seen = new Set();
  for (const tile of tiles) {
    const id = tile.getAttribute('data-item-id');
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const raw = tile.innerText || '';
    if (/sponsored/i.test(raw.slice(0, 120))) continue;

    // Walmart splits the current price across nodes — "Now / $ / 26 / 99" —
    // so innerText reads "$\n26\n99". Whitespace-stripping rejoins it, and the
    // CURRENT price always precedes the struck-through was-price.
    const stripped = raw.replace(/\s+/g, '');
    const m = stripped.match(/\$(\d[\d,]*)\.?(\d{2})(?!\d)/);
    if (!m) continue;
    const price = Number(`${m[1].replace(/,/g, '')}.${m[2]}`);
    if (!Number.isFinite(price) || price <= 0) continue;

    const link = tile.querySelector('a[href*="/ip/"]')?.getAttribute('href') || null;
    const info = meta.get(id) || {};
    const title = info.name
      || (tile.querySelector('a[href*="/ip/"]')?.innerText || '').replace(/\s+/g, ' ').trim()
      || (link ? decodeURIComponent(link.split('/ip/')[1] || '').split('/')[0].replace(/-/g, ' ') : '');
    if (!title) continue;

    out.items.push({
      id,
      title,
      price,
      upc: info.upc || null,
      url: info.url || (link ? `https://www.walmart.com${link.split('?')[0]}` : null),
      outOfStock: !!info.outOfStock || /out of stock/i.test(raw),
      shipping: /free shipping|free delivery/i.test(raw) ? 0 : null,
    });
  }
  return out;
}

const SEARCH_CAP_MS = 15000;

async function runSearch(query, deadline) {
  const timeoutMs = budgetFor(deadline, SEARCH_CAP_MS);
  if (timeoutMs == null) throw new Error('walmart: out of time');
  const url = `https://www.walmart.com/search?q=${encodeURIComponent(query)}`;
  const res = await harvest(url, extractSearchResults, { timeoutMs });
  if (!res || res.blocked) {
    // Surfaced rather than swallowed: the caller logs it, and the user simply
    // sees Target-only results instead of a broken card.
    throw new Error('walmart: bot challenge');
  }
  return res.items || [];
}

/**
 * @param {object} source { title, barcode }
 *
 * Unlike Target — whose search returns nothing for a raw UPC — Walmart's
 * search does resolve barcodes, so we try that first. An exact hit skips the
 * whole matching problem.
 */
export async function search(source, { deadline } = {}) {
  const title = typeof source === 'string' ? source : source?.title;
  const barcode = typeof source === 'string' ? null : source?.barcode;

  let items = [];
  if (barcode) {
    try { items = await runSearch(String(barcode), deadline); } catch (e) {
      if (/bot challenge/.test(e.message)) throw e;
    }
  }
  if (!items.length) {
    const keyword = buildKeyword(title);
    if (!keyword) return [];
    // The barcode attempt has already spent part of the budget. If too little
    // is left, returning nothing beats starting a search that cannot land —
    // "no match" is a true answer, "timed out" is just a wasted 22 seconds.
    if (budgetFor(deadline, SEARCH_CAP_MS) == null) return [];
    items = await runSearch(keyword, deadline);
  }

  return items.map((it) => ({
    retailer: RETAILER.id,
    retailerName: RETAILER.name,
    id: it.id,
    title: decodeEntities(it.title),
    url: it.url,
    price: parsePrice(it.price),
    scrapedShipping: it.shipping,
    barcode: it.upc || null,
    // May be null — unsized goods (electronics, tools, apparel) are legitimate.
    // Filtering on quantity here is what made the Oura Ring invisible.
    quantity: normalizeQuantity(decodeEntities(it.title)),
    inStock: !it.outOfStock,
    // A price of 0 is not a price. Allowing it through produced rows showing
    // bare shipping cost as though it were the item's price.
  })).filter((c) => c.price != null && c.price > 0);
}

/** Walmart's search payload already carries UPC when it has one. */
export async function enrich(candidate) {
  return candidate;
}

export async function lookup(sourceProduct, { preselect, deadline } = {}) {
  const candidates = await search(sourceProduct, { deadline });
  if (!candidates.length) return [];
  return (preselect ? preselect(candidates) : candidates).slice(0, 6);
}
