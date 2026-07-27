/**
 * Target adapter.
 *
 * Target's "redsky" aggregation API is the happy path of this whole project:
 * it answers plain fetch() with clean JSON and no bot challenge. Validated
 * live against both endpoints.
 *
 * One asymmetry matters for cost: the SEARCH endpoint does not return
 * `primary_barcode`, only the PDP endpoint does. Since barcode is what earns a
 * tier-1 match, we have to make a second call per candidate — so candidates are
 * capped hard before fanning out.
 */

import { fetchJson } from '../background/tab-harvester.js';
import { decodeEntities, normalizeQuantity, parsePriceInfo } from '../match/normalize.js';
import { buildKeyword } from '../match/keywords.js';

export { buildKeyword };

// Publicly embedded in Target's own web client.
const REDSKY_KEY = '9f36aeafbe60771e321a7cc95a78140772ab3e96';
const BASE = 'https://redsky.target.com/redsky_aggregations/v1/web';

const DEFAULT_STORE_ID = '3991';
const MAX_PDP_LOOKUPS = 4;

export const RETAILER = {
  id: 'target',
  name: 'Target',
  // Target ships free over $35, or on any order for RedCard holders.
  freeShippingThreshold: 35,
  flatShipping: 5.99,
};

export function shippingFor(subtotal, opts = {}, scraped) {
  if (scraped != null) return scraped;
  if (opts.redcard) return 0;
  return subtotal >= RETAILER.freeShippingThreshold ? 0 : RETAILER.flatShipping;
}

function searchUrl(keyword, storeId) {
  const p = new URLSearchParams({
    key: REDSKY_KEY,
    keyword,
    channel: 'WEB',
    count: '12',
    offset: '0',
    page: `/s/${keyword}`,
    pricing_store_id: storeId,
    visitor_id: '0192B3C4D5E6F7A8B9C0D1E2F3A4B5C6',
  });
  return `${BASE}/plp_search_v2?${p}`;
}

function pdpUrl(tcin, storeId) {
  const p = new URLSearchParams({
    key: REDSKY_KEY,
    tcin,
    store_id: storeId,
    pricing_store_id: storeId,
    has_pricing_store_id: 'true',
    channel: 'WEB',
    page: `/p/A-${tcin}`,
  });
  return `${BASE}/pdp_client_v1?${p}`;
}

/**
 * Target returns "$399.00 - $499.00" for multi-variant products. That is not a
 * price we can compare against, so we surface it as a range and never let it
 * become a saving claim.
 */
function priceOf(node) {
  const info = parsePriceInfo(node?.price?.formatted_current_price);
  if (info?.isRange) return { price: null, priceRange: [info.min, info.max] };
  const price = info?.price
    ?? (typeof node?.price?.current_retail === 'number' ? node.price.current_retail : null);
  return { price, priceRange: null };
}

/**
 * Redsky rate-limits: sustained rapid queries start returning HTTP 403 and stay
 * blocked for a while. Normal browsing (one search per product page) is nowhere
 * near that, but we must not keep hammering once it happens.
 */
let cooldownUntil = 0;
let consecutiveBlocks = 0;
const COOLDOWN_MS = 90 * 1000;

function checkCooldown() {
  if (Date.now() < cooldownUntil) {
    const secs = Math.ceil((cooldownUntil - Date.now()) / 1000);
    throw new Error(`target: rate-limited, retrying in ${secs}s`);
  }
}

/**
 * Back off only after REPEATED blocks.
 *
 * An earlier version tripped a 10-minute cooldown on a single 403 and then
 * threw before even attempting a request — so one transient rate-limit made
 * Target look permanently dead on every product page, and the extension
 * reported "could not reach other retailers" for ten minutes. A single 403 is
 * now just a failed request; two in a row earn a short, self-clearing pause.
 */
function noteFailure(err) {
  if (/\b(403|429)\b/.test(String(err?.message))) {
    consecutiveBlocks += 1;
    if (consecutiveBlocks >= 2) cooldownUntil = Date.now() + COOLDOWN_MS;
  }
  throw err;
}

function noteSuccess() {
  consecutiveBlocks = 0;
  cooldownUntil = 0;
}

/**
 * Search Target for a product.
 * Returns lightweight candidates — no barcode yet, that costs a second call.
 */
export async function search(title, { storeId = DEFAULT_STORE_ID } = {}) {
  checkCooldown();
  const keyword = buildKeyword(title);
  if (!keyword) return [];

  const json = await fetchJson(searchUrl(keyword, storeId)).catch(noteFailure);
  noteSuccess();
  const products = json?.data?.search?.products ?? [];

  return products.map((p) => {
    const t = decodeEntities(p?.item?.product_description?.title ?? '');
    const { price, priceRange } = priceOf(p);
    return {
      retailer: RETAILER.id,
      retailerName: RETAILER.name,
      id: p.tcin,
      title: t,
      url: `https://www.target.com/p/A-${p.tcin}`,
      price,
      priceRange,
      barcode: null,
      // May be null — unsized goods (electronics, apparel) are legitimate.
      quantity: normalizeQuantity(t),
      inStock: true,
    };
  }).filter((c) => c.price != null || c.priceRange);
}

/** Fetch the barcode (and authoritative price) for one candidate. */
export async function enrich(candidate, { storeId = DEFAULT_STORE_ID } = {}) {
  try {
    const json = await fetchJson(pdpUrl(candidate.id, storeId));
    const product = json?.data?.product;
    if (!product) return candidate;
    const title = decodeEntities(product?.item?.product_description?.title ?? candidate.title);
    const { price, priceRange } = priceOf(product);
    return {
      ...candidate,
      title,
      barcode: product?.item?.primary_barcode ?? null,
      price: price ?? (priceRange ? null : candidate.price),
      priceRange: priceRange ?? candidate.priceRange,
      quantity: normalizeQuantity(title) ?? candidate.quantity,
    };
  } catch {
    return candidate; // a failed enrich just means no tier-1 match
  }
}

/**
 * Full lookup: search, then enrich the most plausible few.
 *
 * `preselect` lets the caller (which owns the match gate) narrow candidates
 * before we spend PDP calls on them.
 */
export async function lookup(sourceProduct, { storeId = DEFAULT_STORE_ID, preselect } = {}) {
  const candidates = await search(sourceProduct.title, { storeId });
  if (!candidates.length) return [];

  const shortlist = (preselect ? preselect(candidates) : candidates).slice(0, MAX_PDP_LOOKUPS);
  return Promise.all(shortlist.map((c) => enrich(c, { storeId })));
}
