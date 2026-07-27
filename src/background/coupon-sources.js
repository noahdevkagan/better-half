/**
 * Where candidate coupon codes come from.
 *
 * Aggregator sites block plain fetch() (SimplyCodes 403s, CouponFollow 404s for
 * unknown UAs), but load fine in a real tab — so they go through `harvest()`.
 * Validated live against SimplyCodes.
 *
 * Precision matters more than recall here: the verifier can only afford ~6
 * codes at ~4s each, so a long dirty list is worse than a short clean one.
 */

import { harvest } from './tab-harvester.js';

/**
 * Codes that are obviously per-account referral links rather than public
 * promotions. Seen live on SimplyCodes: LL-89RBSWZD, RAF-RAQIJLLE.
 *
 * These are single-use — testing one CONSUMES it — and they almost never work
 * for a different shopper. We keep them as a last resort but never lead with
 * them.
 */
const REFERRAL_RE = /^(LL|RAF|REF|INV|FRIEND)-/i;

/** Junk that shows up on aggregator pages: their own promos and site chrome. */
const NOISE_RE = /^(SIMPLYCODES|COUPONFOLLOW|RETAILMENOT|HONEY|SHOP|SALE|CODE|HERE|FREE|SHIPPING|NEW|GET)/i;

const SOURCES = [
  (domain) => `https://simplycodes.com/store/${domain}`,
  (domain) => `https://couponfollow.com/site/${domain}`,
];

/**
 * Runs INSIDE the harvested tab. Must be self-contained.
 *
 * We read `[data-code]` rather than scanning text: aggregator pages carry a
 * mega-nav of other retailers, and a text scan pulls in their codes too.
 */
function extractCodes() {
  const out = [];
  const seen = new Set();

  const push = (raw, note) => {
    const c = String(raw || '').trim().toUpperCase();
    if (!c || c.length < 4 || c.length > 24) return;
    if (!/^[A-Z0-9][A-Z0-9-]*$/.test(c)) return;
    if (seen.has(c)) return;
    seen.add(c);
    out.push({ code: c, note: note || null });
  };

  document.querySelectorAll('[data-code], [data-clipboard-text], [data-coupon-code]').forEach((el) => {
    const code = el.getAttribute('data-code')
      || el.getAttribute('data-clipboard-text')
      || el.getAttribute('data-coupon-code');
    // Grab nearby text as a hint of what the code is worth, for ranking.
    const note = (el.closest('li, article, div')?.innerText || '').slice(0, 90).replace(/\s+/g, ' ');
    push(code, note);
  });

  return out;
}

/** Pull the advertised discount out of an aggregator's description text. */
function percentFrom(note) {
  const m = String(note || '').match(/(\d{1,2})\s*%\s*off/i);
  return m ? Number(m[1]) : null;
}

/**
 * Rank candidates so the verifier's small budget is spent well:
 *   public codes with a stated discount  >  public codes  >  referral codes
 */
export function rankCandidates(entries) {
  return entries
    .filter((e) => !NOISE_RE.test(e.code))
    .map((e) => ({ ...e, percent: percentFrom(e.note), referral: REFERRAL_RE.test(e.code) }))
    .sort((a, b) => {
      if (a.referral !== b.referral) return a.referral ? 1 : -1;
      return (b.percent ?? 0) - (a.percent ?? 0);
    });
}

/**
 * Fetch candidate codes for a merchant.
 * `domain` may be a real hostname, or a synthetic key like `shopify:12345`
 * for shared checkout hosts — in which case we have nothing to look up.
 */
export async function fetchCandidates(domain, { limit = 8 } = {}) {
  if (!domain || domain.includes(':')) return [];

  for (const build of SOURCES) {
    try {
      const entries = await harvest(build(domain), extractCodes, { timeoutMs: 12000 });
      if (entries?.length) return rankCandidates(entries).slice(0, limit);
    } catch {
      // Try the next source; a blocked aggregator is expected, not exceptional.
    }
  }
  return [];
}

export const __test__ = { rankCandidates, percentFrom, REFERRAL_RE, NOISE_RE };
