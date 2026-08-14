/** Current-price checks for purchases extracted from Amazon's order history. */

import { harvest } from './tab-harvester.js';

/** Runs inside an Amazon product tab. Keep this function self-contained. */
async function extractAmazonPrice() {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let i = 0; i < 15; i += 1) {
    if (document.querySelector('#productTitle') || /robot check/i.test(document.body?.innerText || '')) break;
    await sleep(300);
  }

  const bodyStart = (document.body?.innerText || '').slice(0, 1800);
  if (/robot check|enter the characters you see below/i.test(bodyStart)) {
    return { blocked: true };
  }
  const title = (document.querySelector('#productTitle')?.innerText || '').replace(/\s+/g, ' ').trim();
  const availability = (document.querySelector('#availability')?.innerText || '').replace(/\s+/g, ' ').trim();
  const unavailable = /currently unavailable|out of stock|unavailable/i.test(availability);
  const box = document.querySelector([
    '#corePrice_feature_div',
    '#apex_desktop',
    '#price_inside_buybox',
    '#corePriceDisplay_desktop_feature_div',
  ].join(','));
  const priceText = box?.querySelector('.a-offscreen')?.textContent || '';
  const match = priceText.replace(/,/g, '').match(/(\d+(?:\.\d{1,2})?)/);
  return {
    blocked: false,
    title,
    price: unavailable || !match ? null : Number(match[1]),
    inStock: !unavailable,
    url: location.href.split('?')[0],
  };
}

const PRICE_TIMEOUT_MS = 15000;
const MAX_ITEMS = 30;

function round2(value) {
  return Math.round(value * 100) / 100;
}

async function checkOne(item) {
  const url = `https://www.amazon.com/dp/${item.asin}`;
  try {
    const current = await harvest(url, extractAmazonPrice, { timeoutMs: PRICE_TIMEOUT_MS });
    if (!current || current.blocked) return { ...item, error: 'Amazon asked for a bot check' };
    const originalPrice = Number(item.originalPrice);
    const currentPrice = Number(current.price);
    const drop = Number.isFinite(originalPrice) && Number.isFinite(currentPrice)
      ? round2(originalPrice - currentPrice)
      : 0;
    return {
      ...item,
      title: item.title || current.title,
      currentTitle: current.title,
      currentPrice: Number.isFinite(currentPrice) ? currentPrice : null,
      currentUrl: current.url || url,
      inStock: current.inStock,
      drop: drop > 0 ? drop : 0,
    };
  } catch (error) {
    return { ...item, error: String(error?.message || error) };
  }
}

/** Check unique ASINs three at a time, then map the answer back to each order. */
export async function checkAmazonPurchases(items = []) {
  const valid = items
    .filter((item) => /^[A-Z0-9]{10}$/.test(String(item?.asin || '')))
    .slice(0, MAX_ITEMS);
  const unique = [...new Map(valid.map((item) => [item.asin, item])).values()];
  const byAsin = new Map();

  for (let i = 0; i < unique.length; i += 3) {
    const batch = await Promise.all(unique.slice(i, i + 3).map(checkOne));
    batch.forEach((result) => byAsin.set(result.asin, result));
  }

  const results = valid.map((item) => ({ ...byAsin.get(item.asin), ...item,
    currentPrice: byAsin.get(item.asin)?.currentPrice ?? null,
    currentUrl: byAsin.get(item.asin)?.currentUrl ?? `https://www.amazon.com/dp/${item.asin}`,
    drop: Number.isFinite(Number(item.originalPrice)) && byAsin.get(item.asin)?.currentPrice != null
      ? Math.max(0, round2(Number(item.originalPrice) - byAsin.get(item.asin).currentPrice))
      : 0,
    error: byAsin.get(item.asin)?.error || null,
  }));
  return {
    results,
    checked: results.filter((item) => item.currentPrice != null).length,
    drops: results.filter((item) => item.drop > 0).length,
    potentialTotal: round2(results.reduce((sum, item) => sum + (item.drop || 0), 0)),
  };
}

export const __test__ = { round2, MAX_ITEMS };
