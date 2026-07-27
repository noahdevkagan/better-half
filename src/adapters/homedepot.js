/**
 * Home Depot adapter.
 *
 * Validated live: no bot challenge, and searching a manufacturer part number
 * ("48-32-4013") returns the exact product. For tools and hardware the MPN is a
 * stronger identifier than any title comparison, and often stronger than UPC —
 * Amazon third-party listings frequently omit the real UPC but keep the MPN in
 * the title.
 *
 * Home Depot renders its results client-side and took ~4s to populate during
 * testing, so the extractor polls rather than reading the DOM once. There is no
 * `__NEXT_DATA__` or Apollo state to shortcut to; the product pods are the
 * data, and they carry clean structured attributes.
 */

import { harvest } from '../background/tab-harvester.js';
import { decodeEntities, normalizeQuantity, parsePriceInfo } from '../match/normalize.js';
import { buildKeyword } from '../match/keywords.js';

export { buildKeyword };

export const RETAILER = {
  id: 'homedepot',
  name: 'Home Depot',
  freeShippingThreshold: 45,
  flatShipping: 8.99,
};

/**
 * Shipping cost.
 *
 * `scraped` is what the page actually says, and it always wins. The threshold
 * below is a last-resort guess and it has already been wrong once: this
 * adapter priced the $44.99 Milwaukee set as needing $8.99 of shipping because
 * it sat one cent under a $45 threshold, while the page plainly read
 * "Delivery Tue, Jul 28 — FREE". Inventing shipping flips the verdict.
 */
export function shippingFor(subtotal, opts = {}, scraped) {
  if (scraped != null) return scraped;
  if (opts.homeDepotShipToStore !== false) return 0; // free ship-to-store
  return subtotal >= RETAILER.freeShippingThreshold ? 0 : RETAILER.flatShipping;
}

/**
 * Runs INSIDE the harvested tab. Self-contained, and async so it can wait for
 * the SPA to render.
 */
async function extractPods() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let pods = [];
  for (let i = 0; i < 20; i += 1) {
    pods = [...document.querySelectorAll('[data-testid="product-pod"], .product-pod')];
    if (pods.length) break;
    if (/robot|are you a human|access denied|unusual traffic/i.test(document.body.innerText.slice(0, 1200))) {
      return { blocked: true, items: [] };
    }
    await sleep(400);
  }
  if (!pods.length) return { blocked: false, items: [] };

  const seen = new Set();
  const items = [];
  for (const pod of pods) {
    const id = pod.getAttribute('data-product-id');
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const text = (pod.innerText || '').replace(/\s+/g, ' ');
    const link = pod.querySelector('a[href*="/p/"]')?.getAttribute('href') || null;
    const brand = pod.querySelector('[class*="brand"], [data-testid*="brand"]')?.innerText?.trim() || null;

    // Price nodes render as split spans that innerText re-joins, and a
    // discounted pod concatenates everything:
    //   "$119.00$139.00Save$20.00(14%)"
    // The CURRENT price is always first, so we take the leading amount rather
    // than the smallest — "Save $20.00" must never be read as the price.
    let priceText = null;
    for (const el of pod.querySelectorAll('[class*="price"], [data-testid*="price"]')) {
      const t = (el.innerText || '').replace(/\s+/g, '');
      const m = t.match(/\$(\d[\d,]*\.?\d{0,2})/);
      if (m) { priceText = `$${m[1]}`; break; }
    }

    // Pod anchors wrap an image, so their innerText is usually empty. The URL
    // slug is clean, always present, and carries the full product name.
    let title = (pod.querySelector('a[href*="/p/"]')?.innerText || '').replace(/\s+/g, ' ').trim();
    if (!title && link) {
      title = decodeURIComponent(link.split('/p/')[1] || '').split('/')[0].replace(/-/g, ' ').trim();
    }

    // The pod states shipping outright ("Ship to Store: Free", "FREE Delivery").
    // Reading it beats guessing from an order threshold.
    let shipping = null;
    if (/free\s*(?:2-day\s*|1-2\s*day\s*|standard\s*)?(?:delivery|shipping)|ship to store:?\s*free/i.test(text)) {
      shipping = 0;
    } else {
      const paid = text.match(/(?:delivery|shipping)[^$]{0,20}\$(\d+(?:\.\d{2})?)/i);
      if (paid) shipping = Number(paid[1]);
    }

    items.push({
      id,
      title,
      brand,
      model: (text.match(/Model#\s*([A-Za-z0-9][A-Za-z0-9-]*)/i) || [])[1] || null,
      priceText,
      shipping,
      url: link ? `https://www.homedepot.com${link}` : null,
      outOfStock: /out of stock|unavailable/i.test(text),
    });
  }
  return { blocked: false, items };
}

async function runSearch(query) {
  const url = `https://www.homedepot.com/s/${encodeURIComponent(query)}`;
  const res = await harvest(url, extractPods, { timeoutMs: 20000 });
  if (!res) return [];
  if (res.blocked) throw new Error('homedepot: bot challenge');
  return res.items || [];
}

/**
 * @param {object} source { title, model, barcode }
 *
 * Model number first: it is exact, and Home Depot's search resolves it
 * directly. Keyword search is the fallback.
 */
export async function search(source) {
  const title = typeof source === 'string' ? source : source?.title;
  const model = typeof source === 'string' ? null : source?.model;

  let items = [];
  if (model) {
    try { items = await runSearch(model); } catch (e) {
      if (/bot challenge/.test(e.message)) throw e;
    }
  }
  if (!items.length) {
    const keyword = buildKeyword(title);
    if (!keyword) return [];
    items = await runSearch(keyword);
  }

  return items.map((it) => {
    const info = parsePriceInfo(it.priceText);
    const t = decodeEntities(it.title);
    return {
      retailer: RETAILER.id,
      retailerName: RETAILER.name,
      id: it.id,
      title: t,
      brand: it.brand,
      model: it.model,
      url: it.url,
      price: info?.isRange ? null : (info?.price ?? null),
      priceRange: info?.isRange ? [info.min, info.max] : null,
      scrapedShipping: it.shipping,
      barcode: null,
      quantity: normalizeQuantity(t),
      inStock: !it.outOfStock,
    };
  }).filter((c) => c.price != null || c.priceRange);
}

export async function enrich(candidate) {
  return candidate;
}

export async function lookup(sourceProduct, { preselect } = {}) {
  const candidates = await search(sourceProduct);
  if (!candidates.length) return [];
  return (preselect ? preselect(candidates) : candidates).slice(0, 6);
}
