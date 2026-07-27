/**
 * The match gate: "is the thing on this other retailer's shelf the SAME thing?"
 *
 * Showing a wrong comparison is worse than showing none, so anything that
 * doesn't clear a tier is discarded rather than shown with a caveat.
 *
 * Two rules here came directly from real pages, and both would have broken a
 * more obvious implementation:
 *
 *   - "Powder" is NOT usable as a discriminator. Amazon calls the 30.2oz tub
 *     "Baby Formula Powder"; Target calls the identical UPC "Infant Formula"
 *     with no such word. Using it would reject a confirmed barcode match.
 *     Powder-vs-liquid is decided by unit FAMILY instead.
 *
 *   - Discriminators need synonyms. Amazon says "Max Strength", Target says
 *     "Maximum Strength", same UPC. Matching literal strings would reject it.
 */

import { FAMILY, barcodesMatch, decodeEntities, stripBidi, stripVariantAttrs } from './normalize.js';

export { stripVariantAttrs };

export const TIER = {
  REJECT: 0,
  /** Same barcode. Safe to compare total prices directly. */
  EXACT_BARCODE: 1,
  /**
   * Same manufacturer part number. For tools and hardware this is as strong as
   * a barcode — often stronger, since third-party listings drop the real UPC
   * but keep the MPN.
   */
  EXACT_MODEL: 4,
  /** Same product line and same pack size. Safe to compare totals. */
  CONFIDENT: 2,
  /**
   * Same product line, DIFFERENT pack size (retailers do this deliberately to
   * defeat comparison). Only ever compared by unit price — comparing totals
   * here is exactly how you "find" a fake $13 saving between a 34.9oz tub and
   * a 20.1oz one.
   */
  EQUIVALENT_UNIT: 3,
};

export const VERDICT = {
  CHEAPER_ELSEWHERE: 'CHEAPER_ELSEWHERE',
  NO_SAVING: 'NO_SAVING',
  UNAVAILABLE_HERE_AVAILABLE_THERE: 'UNAVAILABLE_HERE_AVAILABLE_THERE',
  /**
   * The other retailer lists a price RANGE across variants (finish, size), and
   * its low end undercuts what you're looking at. We cannot claim a saving —
   * the cheap variant may not be the one you want — but pointing at it and
   * letting the shopper check is both honest and useful.
   */
  PRICE_VARIES: 'PRICE_VARIES',
  NO_VERIFIED_MATCH: 'NO_VERIFIED_MATCH',
};

/**
 * Product-line qualifiers. If either title asserts one of these and the other
 * does not, they are different products — full stop.
 */
const DISCRIMINATORS = [
  ['maxStrength', /\bmax(?:imum)?\s+strength\b/i],
  ['originalStrength', /\boriginal\s+strength\b/i],
  ['sensitive', /\bsensitive\b/i],
  ['gentleComfort', /\bgentle\s+comfort\b/i],
  ['readyToFeed', /\bready[\s-]?to[\s-]?feed\b/i],
  ['concentrate', /\bconcentrate\b/i],
  ['organic', /\borganic\b/i],
  ['hypoallergenic', /\bhypoallergenic\b/i],
  ['soy', /\bsoy\b/i],
  ['proAdvance', /\bpro[\s-]?advance\b/i],
  ['unscented', /\b(?:unscented|fragrance[\s-]?free)\b/i],
];

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'with', 'in', 'of', 'to', 'by', 'on',
  'baby', 'babies', 'infant', 'new', 'value', 'size', 'pack', 'count', 'ct',
  'oz', 'ounce', 'ounces', 'fl', 'each', 'tub', 'can', 'jar', 'bottle', 'free',
]);

/**
 * Content tokens, order preserved.
 * Decimal numbers are dropped because they are sizes ("30.2"), but bare
 * integers are kept because they are often the product line ("360").
 */
function contentTokens(title) {
  return decodeEntities(stripBidi(title))
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOPWORDS.has(t) && !/^\d+\.\d+$/.test(t));
}

/** Manufacturer part numbers, compared ignoring punctuation and case. */
export function normalizeModel(model) {
  const s = String(model || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  // Too short to be discriminating — "5" or "AB" would match half the catalogue.
  return s.length >= 5 ? s : null;
}

export function modelsMatch(a, b) {
  const na = normalizeModel(a);
  const nb = normalizeModel(b);
  return !!na && !!nb && na === nb;
}

/**
 * Flag a brand disagreement.
 *
 * A real case: Amazon listing B0DK6HZ93H carries model 48-32-4013 but brand
 * "LRYXYY", with a title reading "…for Milwaukee". Home Depot sells the genuine
 * Milwaukee under the same model number. The comparison is legitimate and
 * useful — the shopper is probably better off with the real one — but pretending
 * they're the same brand would be misleading.
 */
const COMPATIBLE_PHRASE = /\b(?:for|compatible\s+with|replacement\s+for|fits)\s+([A-Z][A-Za-z]{2,})\b/;

function brandInfo(source, candidate) {
  const a = String(source.brand || '').trim();
  const b = String(candidate.brand || '').trim();
  if (!a || !b) return {};
  if (a.toLowerCase() === b.toLowerCase()) return {};

  const compat = COMPATIBLE_PHRASE.exec(source.title || '');
  const aftermarket = !!compat && compat[1].toLowerCase() === b.toLowerCase();
  return {
    brandNote: aftermarket
      ? `this listing is "${a}" made for ${b}; ${b} sells it directly`
      : `brand differs: ${a} here vs ${b} there`,
    aftermarket,
  };
}

function discriminatorProfile(title) {
  const text = decodeEntities(stripBidi(title));
  const profile = {};
  for (const [key, re] of DISCRIMINATORS) profile[key] = re.test(text);
  return profile;
}

function discriminatorsAgree(a, b) {
  const pa = discriminatorProfile(a);
  const pb = discriminatorProfile(b);
  const conflicts = [];
  for (const [key] of DISCRIMINATORS) {
    if (pa[key] !== pb[key]) conflicts.push(key);
  }
  return { ok: conflicts.length === 0, conflicts };
}

/**
 * Do the leading identifying tokens of the shorter title all appear in the
 * longer one? Brand and product line lead almost every retail title, so this
 * is a stronger and far more explainable signal than bag-of-words overlap
 * (which fails when one retailer writes a 200-character title and the other
 * writes 60).
 */
function leadTokensPresent(a, b, n = 4) {
  // Compare on the product, not on its colour or fitted size.
  const ta = contentTokens(stripVariantAttrs(a).cleaned);
  const tb = contentTokens(stripVariantAttrs(b).cleaned);
  if (!ta.length || !tb.length) return { ok: false, missing: ['<empty title>'] };
  const [shortT, longT] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const longSet = new Set(longT);
  const lead = shortT.slice(0, n);
  const missing = lead.filter((t) => !longSet.has(t));
  return { ok: missing.length === 0, missing };
}

function quantitiesMatch(qa, qb, tolerance = 0.02) {
  if (!qa || !qb) return { ok: false, reason: 'unparseable quantity' };
  if (qa.family !== qb.family) {
    return { ok: false, reason: `unit family ${qa.family} vs ${qb.family}` };
  }
  if (!qa.total || !qb.total) return { ok: false, reason: 'zero quantity' };
  const rel = Math.abs(qa.total - qb.total) / Math.max(qa.total, qb.total);
  if (rel > tolerance) {
    return { ok: false, reason: `size ${qa.total}${qa.unitLabel} vs ${qb.total}${qb.unitLabel}` };
  }
  return { ok: true };
}

/**
 * Score a candidate against the source product.
 *
 * `source` / `candidate`: { title, barcode, quantity }  (quantity from normalizeQuantity)
 */
export function matchConfidence(source, candidate) {
  const reasons = [];

  if (barcodesMatch(source.barcode, candidate.barcode)) {
    return { tier: TIER.EXACT_BARCODE, reasons: ['barcode match'], ...brandInfo(source, candidate) };
  }

  if (modelsMatch(source.model, candidate.model)) {
    return { tier: TIER.EXACT_MODEL, reasons: ['model number match'], ...brandInfo(source, candidate) };
  }

  // Differing barcodes mean a different SKU — but very often that is the same
  // product in a different pack size, which is still worth comparing per unit.
  // We record the fact and let the size check below decide the tier.
  const barcodesDiffer = !!(source.barcode && candidate.barcode);

  const disc = discriminatorsAgree(source.title, candidate.title);
  if (!disc.ok) {
    return { tier: TIER.REJECT, reasons: [`variant mismatch: ${disc.conflicts.join(', ')}`] };
  }
  reasons.push('variant qualifiers agree');

  const lead = leadTokensPresent(source.title, candidate.title);
  if (!lead.ok) {
    return { tier: TIER.REJECT, reasons: [`brand/line mismatch: missing ${lead.missing.join(', ')}`] };
  }
  reasons.push('brand and product line agree');

  // Plenty of products have no size at all — a smart ring, a pair of
  // headphones, a jacket. Requiring a parseable quantity made every
  // non-consumable invisible. When NEITHER side has one, we simply compare the
  // items as single units, but demand stronger title agreement to compensate
  // for the missing signal.
  if (!source.quantity && !candidate.quantity) {
    const strict = leadTokensPresent(source.title, candidate.title, 6);
    if (!strict.ok) {
      return { tier: TIER.REJECT, reasons: [`unsized item, weak title match: missing ${strict.missing.join(', ')}`] };
    }
    reasons.push('unsized item, strong title match');
    // Disclose any colour/size difference rather than pretending it isn't there.
    const theirs = stripVariantAttrs(candidate.title).variants;
    const mine = stripVariantAttrs(source.title).variants;
    const differing = theirs.filter((v) => !mine.includes(v));
    return {
      tier: TIER.CONFIDENT,
      reasons,
      variantNote: differing.length ? differing.join(', ') : null,
    };
  }

  // One side sized and the other not means we cannot say they're the same.
  if (!source.quantity || !candidate.quantity) {
    return { tier: TIER.REJECT, reasons: ['size known on only one side'] };
  }
  if (source.quantity.family !== candidate.quantity.family) {
    return {
      tier: TIER.REJECT,
      reasons: [`unit family ${source.quantity.family} vs ${candidate.quantity.family}`],
    };
  }

  const qty = quantitiesMatch(source.quantity, candidate.quantity);
  if (qty.ok) {
    reasons.push('size and unit family agree');
    return { tier: TIER.CONFIDENT, reasons };
  }

  // Same line, same unit family, different pack size.
  reasons.push(`different pack size (${qty.reason})`);
  if (barcodesDiffer) reasons.push('different SKU');
  return { tier: TIER.EQUIVALENT_UNIT, reasons };
}

/**
 * Turn matched offers into the thing we actually show the user.
 *
 * All four verdicts below were observed during live validation; a comparison
 * UI that only knows how to render a price delta is wrong most of the time.
 */
export function buildVerdict(source, offers, opts = {}) {
  const minRelSaving = opts.minRelSaving ?? 0.02; // 2%
  const minAbsSaving = opts.minAbsSaving ?? 1.0;  // $1

  const direct = offers.filter(
    (o) => (o.tier === TIER.EXACT_BARCODE || o.tier === TIER.EXACT_MODEL || o.tier === TIER.CONFIDENT)
      && o.inStock && o.total != null,
  );
  const perUnit = offers.filter(
    (o) => o.tier === TIER.EQUIVALENT_UNIT && o.inStock && o.unitPrice != null,
  );

  // Out of stock here is a result in its own right, and often the most useful
  // one — a price delta of nothing still beats "we found nothing".
  if (!source.inStock) {
    const pool = direct.length ? sortBy(direct, 'total') : sortBy(perUnit, 'unitPrice');
    if (!pool.length) return { verdict: VERDICT.NO_VERIFIED_MATCH, offers: [] };
    return {
      verdict: VERDICT.UNAVAILABLE_HERE_AVAILABLE_THERE,
      comparedBy: direct.length ? 'total' : 'unit',
      offers: pool,
      best: pool[0],
    };
  }

  if (direct.length) {
    const sorted = sortBy(direct, 'total');
    return decide(sorted, source.total, sorted[0].total, 'total');
  }

  // Fall back to unit price. Retailers deliberately sell mismatched pack sizes,
  // so this is the common case, not an edge case.
  if (perUnit.length && source.unitPrice != null) {
    const sorted = sortBy(perUnit, 'unitPrice');
    return decide(sorted, source.unitPrice, sorted[0].unitPrice, 'unit');
  }

  // Matched, but the other retailer quotes a range across variants. Never a
  // saving claim — only a pointer worth following.
  const ranged = offers.filter(
    (o) => o.tier !== TIER.REJECT && o.inStock && o.priceRange && o.price == null,
  );
  if (ranged.length && source.total != null) {
    const cheapest = ranged.reduce((a, b) => (a.priceRange[0] <= b.priceRange[0] ? a : b));
    if (cheapest.priceRange[0] < source.total) {
      return { verdict: VERDICT.PRICE_VARIES, offers: ranged, best: cheapest, comparedBy: 'range' };
    }
  }

  return { verdict: VERDICT.NO_VERIFIED_MATCH, offers: [] };

  function decide(sorted, mine, theirs, comparedBy) {
    const delta = mine - theirs;
    const rel = mine ? delta / mine : 0;
    const base = { offers: sorted, best: sorted[0], comparedBy, delta: round2(delta) };

    if (delta >= (comparedBy === 'unit' ? 0 : minAbsSaving) && rel >= minRelSaving) {
      // For unit comparisons the absolute figure is per-ounce, so the dollar
      // floor doesn't apply; the relative floor still guards against noise.
      return { ...base, verdict: VERDICT.CHEAPER_ELSEWHERE, saving: round2(delta) };
    }
    return { ...base, verdict: VERDICT.NO_SAVING, saving: 0 };
  }
}

/**
 * Sort, and keep only the BEST offer from each retailer.
 *
 * A retailer's search returns many near-identical listings — five OutdoorMaster
 * helmet variants, say — and rendering all of them turned the card into a wall
 * of repeated "Walmart" rows. One row per store is what a shopper can act on.
 */
function sortBy(offers, key) {
  const best = new Map();
  for (const o of offers) {
    const k = o.retailer || o.retailerName || 'unknown';
    const prev = best.get(k);
    if (!prev || o[key] < prev[key]) best.set(k, o);
  }
  return [...best.values()].sort((a, b) => a[key] - b[key]);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

export const __test__ = { discriminatorProfile, leadTokensPresent, contentTokens, quantitiesMatch };
