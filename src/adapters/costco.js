/**
 * Costco.com adapter.
 *
 * Costco is opt-in because it requires an additional host permission. Search
 * and product pages are harvested in a real browser tab: member-only prices
 * may be visible only when the shopper is already signed in to Costco.
 */

import { harvest, budgetFor } from '../background/tab-harvester.js';
import { decodeEntities, normalizeQuantity, parsePrice } from '../match/normalize.js';
import { buildKeyword } from '../match/keywords.js';

export { buildKeyword };

export const RETAILER = {
  id: 'costco',
  name: 'Costco',
};

// Costco sometimes includes shipping in the online price and sometimes adds a
// per-item fee. Unknown shipping must not become an invented savings claim.
export function shippingFor(_subtotal, _opts = {}, scraped) {
  return scraped == null ? null : scraped;
}

/** Runs inside Costco's search-result tab. Keep this function self-contained. */
async function extractSearchResults() {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const blocked = () => /access denied|verify you are human|unusual traffic/i
    .test((document.body?.innerText || '').slice(0, 1600));

  let links = [];
  for (let i = 0; i < 20; i += 1) {
    if (blocked()) return { blocked: true, items: [] };
    links = [...document.querySelectorAll([
      'a[href*="/p/-/"]',
      'a[href*=".product."]',
      'a[href*="/product."]',
    ].join(','))];
    if (links.length) break;
    await sleep(400);
  }

  const seen = new Set();
  const items = [];
  for (const link of links) {
    const href = link.href || link.getAttribute('href') || '';
    if (!href || seen.has(href)) continue;

    let card = link;
    for (let i = 0; i < 7 && card?.parentElement; i += 1) {
      const parent = card.parentElement;
      const text = parent.innerText || '';
      card = parent;
      if (/\$\s*[\d,]+(?:\.\d{2})?/.test(text) && text.length < 2400) break;
    }
    const raw = (card?.innerText || '').replace(/\s+/g, ' ').trim();
    if (!raw) continue;

    const heading = card.querySelector('h1,h2,h3,h4,[automation-id*="productTileName"]');
    const title = (link.innerText || link.getAttribute('aria-label') || heading?.innerText || '')
      .replace(/\s+/g, ' ').trim();
    const priceMatch = raw.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
    const price = priceMatch ? Number(priceMatch[1].replace(/,/g, '')) : null;
    if (!title || !Number.isFinite(price) || price <= 0) continue;

    seen.add(href);
    items.push({
      id: (href.match(/\/(\d{7,9})(?:[/?]|\.html)/) || [])[1] || href,
      title,
      url: href.split('?')[0],
      price,
      outOfStock: /out of stock|unavailable/i.test(raw),
      shipping: /shipping\s*&\s*handling included/i.test(raw) ? 0 : null,
    });
  }
  return { blocked: false, items };
}

/** Runs inside a Costco product tab. Keep this function self-contained. */
async function extractProduct() {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let i = 0; i < 15; i += 1) {
    if (document.querySelector('h1') || /access denied/i.test(document.body?.innerText || '')) break;
    await sleep(400);
  }

  const body = (document.body?.innerText || '').replace(/\s+/g, ' ');
  if (/access denied|verify you are human|unusual traffic/i.test(body.slice(0, 1800))) {
    return { blocked: true };
  }
  const title = (document.querySelector('h1')?.innerText || '').replace(/\s+/g, ' ').trim();
  const explicit = document.querySelector([
    '[itemprop="price"][content]',
    'meta[property="product:price:amount"]',
    '[automation-id="productPriceOutput"]',
  ].join(','));
  const explicitValue = explicit?.getAttribute('content') || explicit?.innerText || '';
  const priceText = explicitValue || (body.match(/(?:Online Price|Member Only Item)[^$]{0,100}(\$[\d,]+(?:\.\d{2})?)/i) || [])[1] || '';
  const paidShipping = body.match(/shipping\s*(?:&|and)\s*handling(?: fee)?\s*:?\s*\$([\d,]+(?:\.\d{2})?)/i);
  const shipping = /shipping\s*&\s*handling included/i.test(body)
    ? 0
    : paidShipping ? Number(paidShipping[1].replace(/,/g, '')) : null;
  return {
    blocked: false,
    title,
    priceText,
    shipping,
    outOfStock: /out of stock|currently unavailable|unavailable for purchase/i.test(body),
  };
}

const SEARCH_CAP_MS = 15000;
const PDP_CAP_MS = 10000;

async function search(source, deadline) {
  const keyword = buildKeyword(source.title);
  if (!keyword) return [];
  const timeoutMs = budgetFor(deadline, SEARCH_CAP_MS);
  if (timeoutMs == null) return [];
  const url = `https://www.costco.com/s?keyword=${encodeURIComponent(keyword)}`;
  const result = await harvest(url, extractSearchResults, { timeoutMs });
  if (result?.blocked) throw new Error('costco: bot challenge');
  return result?.items || [];
}

async function enrich(candidate, deadline) {
  const timeoutMs = budgetFor(deadline, PDP_CAP_MS);
  if (timeoutMs == null) return candidate;
  try {
    const product = await harvest(candidate.url, extractProduct, { timeoutMs });
    if (!product || product.blocked) return candidate;
    return {
      ...candidate,
      title: product.title || candidate.title,
      price: parsePrice(product.priceText) ?? candidate.price,
      scrapedShipping: product.shipping ?? candidate.shipping,
      inStock: !product.outOfStock,
    };
  } catch {
    return candidate;
  }
}

export async function lookup(source, { preselect, deadline } = {}) {
  const items = await search(source, deadline);
  const candidates = items.map((item) => ({
    retailer: RETAILER.id,
    retailerName: RETAILER.name,
    id: item.id,
    title: decodeEntities(item.title),
    url: item.url,
    price: parsePrice(item.price),
    scrapedShipping: item.shipping,
    barcode: null,
    quantity: normalizeQuantity(decodeEntities(item.title)),
    inStock: !item.outOfStock,
  })).filter((candidate) => candidate.price != null && candidate.price > 0);

  const shortlist = (preselect ? preselect(candidates) : candidates).slice(0, 3);
  return Promise.all(shortlist.map((candidate) => enrich(candidate, deadline)));
}
