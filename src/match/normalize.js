/**
 * Size / unit normalization.
 *
 * The whole point of this file is to make "is this the same thing?" answerable.
 * Two rules drive every decision here, both learned from real product pages:
 *
 *   1. Weight, volume and count are SEPARATE NAMESPACES. Ready-to-feed formula
 *      at $0.40/fl oz looks 4.5x cheaper than powder at $1.82/oz. It is not
 *      cheaper, it is a different product. We never convert between families.
 *
 *   2. "fl oz" must be matched before "oz", or "32 fl oz" silently parses as
 *      32 ounces of powder. Alternation order below is load-bearing.
 */

export const FAMILY = { WEIGHT: 'WEIGHT', VOLUME: 'VOLUME', COUNT: 'COUNT' };

// Canonical unit per family: ounces, fluid ounces, and bare count.
const VOLUME_TO_FLOZ = {
  'fl oz': 1, 'floz': 1, 'fluid ounce': 1, 'fluid ounces': 1,
  'ml': 0.0338140226, 'milliliter': 0.0338140226, 'milliliters': 0.0338140226,
  'l': 33.8140226, 'liter': 33.8140226, 'liters': 33.8140226,
  'qt': 32, 'quart': 32, 'quarts': 32,
};

const WEIGHT_TO_OZ = {
  'oz': 1, 'ounce': 1, 'ounces': 1,
  'lb': 16, 'lbs': 16, 'pound': 16, 'pounds': 16,
  'g': 0.0352739619, 'gram': 0.0352739619, 'grams': 0.0352739619,
  'kg': 35.2739619, 'kilogram': 35.2739619, 'kilograms': 35.2739619,
};

const COUNT_UNITS = new Set(['ct', 'count', 'counts', 'pk', 'pack', 'packs', 'each']);

// Order matters. Longest / most specific first, and every volume spelling that
// starts with a weight spelling ("fl oz" vs "oz") must come first.
const UNIT_ALTERNATION = [
  // volume
  'fl\\.?\\s*ozs?', 'fluid\\s+ounces?', 'milliliters?', 'ml', 'liters?', 'l',
  'quarts?', 'qt',
  // weight
  'ounces?', 'oz', 'pounds?', 'lbs?', 'lb', 'kilograms?', 'kg', 'grams?', 'g',
  // count
  'counts?', 'ct', 'packs?', 'pk',
].join('|');

// `(?![a-z])` stops `l` from eating the "l" in "lb" and `g` the "g" in "gram".
const QTY_RE = new RegExp(
  `(\\d+(?:\\.\\d+)?)\\s*-?\\s*(${UNIT_ALTERNATION})(?![a-z])`,
  'gi',
);

/** Decode the HTML entities Target's redsky API returns in titles. */
export function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/<[^>]+>/g, '');
}

/**
 * Variant attributes: colour and fitted size.
 *
 * These identify a VARIANT, not a product. An Oura Ring in Silver size 10 and
 * one in Deep Rose size 8 are the same product at the same price. Treating
 * "silver" as identifying makes matching reject good comparisons, and putting
 * "deep rose" in a search query hunts for a colour the other retailer may not
 * stock. Product-line qualifiers ("Sensitive", "Max Strength") are handled
 * separately and DO block a match.
 */
// The optional prefix catches compound finishes: "deep rose", "space gray".
const COLOR_WORDS = /\b(?:deep|light|dark|space|matte|brushed|rose)?\s*(silver|gold|golden|black|white|rose|stealth|titanium|blue|green|red|pink|gray|grey|bronze|brushed|matte|glossy|graphite|midnight|sand|slate|charcoal|cream|navy|purple|orange|yellow|beige|tan|ivory|copper|platinum|clear|natural)\b/gi;
const SIZE_PHRASE = /\bsizes?\s*[:#-]?\s*(\d{1,2}|x?s|m|l|x{0,3}l)\b/gi;

export function stripVariantAttrs(title) {
  const text = decodeEntities(stripBidi(title));
  const found = [];
  const cleaned = text
    .replace(SIZE_PHRASE, (m) => { found.push(m.trim()); return ' '; })
    .replace(COLOR_WORDS, (m) => { found.push(m.trim()); return ' '; });
  return { cleaned, variants: [...new Set(found.map((v) => v.toLowerCase()))] };
}

/** Amazon injects bidi control characters into its detail-table labels. */
export function stripBidi(s) {
  return String(s || '').replace(/[‎‏؜‪-‮]/g, '');
}

function classifyUnit(raw) {
  const u = raw.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
  const flat = u.replace(/\s/g, '');
  if (flat === 'floz' || flat === 'flozs') return { family: FAMILY.VOLUME, factor: 1, label: 'fl oz' };
  if (u in VOLUME_TO_FLOZ) return { family: FAMILY.VOLUME, factor: VOLUME_TO_FLOZ[u], label: 'fl oz' };
  if (u in WEIGHT_TO_OZ) return { family: FAMILY.WEIGHT, factor: WEIGHT_TO_OZ[u], label: 'oz' };
  if (COUNT_UNITS.has(u)) return { family: FAMILY.COUNT, factor: 1, label: 'ct' };
  return null;
}

/**
 * How many individual units are in this listing?
 * Handles "3pk", "Pack of 3", "3 Count", and "2 fl oz Each/12ct".
 */
export function parsePackCount(text) {
  const t = String(text || '');
  const each = t.match(/each\s*\/\s*(\d+)\s*(?:ct|count|pk|pack)\b/i);
  if (each) return Number(each[1]);
  const packOf = t.match(/pack\s+of\s+(\d+)/i);
  if (packOf) return Number(packOf[1]);
  const nPk = t.match(/(\d+)\s*-?\s*(?:pk|packs?)\b/i);
  if (nPk) return Number(nPk[1]);
  const nCt = t.match(/(\d+)\s*-?\s*(?:ct|counts?)\b/i);
  if (nCt) return Number(nCt[1]);
  return 1;
}

/**
 * Pull every number+unit pair out of a string.
 * Returns them in document order so callers can pick the most meaningful one.
 */
export function parseAllQuantities(text) {
  const out = [];
  const t = String(text || '');
  QTY_RE.lastIndex = 0;
  let m;
  while ((m = QTY_RE.exec(t)) !== null) {
    const cls = classifyUnit(m[2]);
    if (!cls) continue;
    out.push({
      value: Number(m[1]),
      family: cls.family,
      canonical: Number(m[1]) * cls.factor,
      unitLabel: cls.label,
      raw: m[0],
      index: m.index,
    });
  }
  return out;
}

/**
 * Normalize a listing into a comparable quantity.
 *
 * `structured` accepts Amazon's detail-table fields, which are far more
 * reliable than the title when present:
 *   { unitCount: "104.7 Ounce", numberOfItems: "3", eachUnitCount: "34.9", size: "34.9 Ounce (Pack of 3)" }
 *
 * Returns null when nothing parseable is found — callers must treat that as
 * "cannot verify", never as "assume 1".
 */
export function normalizeQuantity(title, structured = {}) {
  const text = decodeEntities(stripBidi(title));
  const packFromText = parsePackCount(text);

  // Structured fields win when Amazon gives them to us.
  const numberOfItems = toNum(structured.numberOfItems);
  const eachUnitCount = toNum(structured.eachUnitCount);
  const sizeText = stripBidi(structured.size || '');

  // Establish the family from whatever text we have; a size field is the most
  // specific, then the title.
  const candidates = [
    ...parseAllQuantities(sizeText),
    ...parseAllQuantities(structured.unitCount || ''),
    ...parseAllQuantities(text),
  ];
  const sized = candidates.find((c) => c.family !== FAMILY.COUNT);
  if (!sized) return null;

  const family = sized.family;
  const unitLabel = sized.unitLabel;

  let each = eachUnitCount;
  let count = numberOfItems || packFromText || parsePackCount(sizeText) || 1;

  if (each == null) {
    // Prefer a size-field reading, else the first same-family hit in the title.
    const fromSize = parseAllQuantities(sizeText).find((c) => c.family === family);
    const fromTitle = parseAllQuantities(text).find((c) => c.family === family);
    const pick = fromSize || fromTitle || sized;
    each = pick.canonical;
  } else if (family === FAMILY.WEIGHT || family === FAMILY.VOLUME) {
    // eachUnitCount is bare ("34.9"); it inherits the family's canonical unit.
    each = each * 1;
  }

  const total = round4(each * count);
  return { family, unitLabel, each: round4(each), count, total };
}

/** Price per canonical unit. Returns null unless both inputs are usable. */
export function unitPrice(priceUsd, quantity) {
  if (priceUsd == null || !quantity || !quantity.total) return null;
  return round4(priceUsd / quantity.total);
}

/**
 * UPC / GTIN comparison.
 * GTIN-14 "00070074681238" and UPC-12 "070074681238" are the same product;
 * leading zeros are padding, not data.
 */
export function normalizeBarcode(code) {
  const digits = String(code || '').replace(/\D/g, '');
  if (!digits) return null;
  const stripped = digits.replace(/^0+/, '');
  return stripped || '0';
}

/**
 * A UPC field can hold SEVERAL codes.
 *
 * Amazon listing B001A4CWHO reports
 *   "786830337782 795871624188 744211231548 727708084407"
 * — one per variant. Stripping non-digits would weld them into a single
 * 48-digit number that matches nothing.
 */
export function parseBarcodes(field) {
  return String(field || '')
    .split(/[\s,;/|]+/)
    .map(normalizeBarcode)
    .filter(Boolean);
}

/** True when the two fields share ANY barcode. */
export function barcodesMatch(a, b) {
  const as = parseBarcodes(a);
  const bs = parseBarcodes(b);
  if (!as.length || !bs.length) return false;
  const set = new Set(as);
  return bs.some((code) => set.has(code));
}

/**
 * Parse a price string, and say whether it is a RANGE.
 *
 * This matters more than it looks. Target returns "$399.00 - $499.00" for
 * multi-variant products (an Oura Ring in different finishes). Grabbing the
 * first number yields $399 — which against Amazon's $499 invents a $100 saving
 * for a variant the shopper may not be able to buy at that price.
 *
 * A range is not a price. Callers must refuse to claim a saving on one.
 */
export function parsePriceInfo(text) {
  if (typeof text === 'number') {
    return Number.isFinite(text) ? { price: text, min: text, max: text, isRange: false } : null;
  }
  const s = String(text || '').replace(/,/g, '');
  const nums = [...s.matchAll(/(\d+(?:\.\d{1,2})?)/g)].map((m) => Number(m[1]));
  if (!nums.length) return null;

  // "$399.00 - $499.00" / "$399.00 to $499.00"
  const isRange = nums.length > 1 && /\d\s*(?:-|–|—|to)\s*\$?\d/.test(s) && nums[0] !== nums[1];
  if (isRange) {
    const min = Math.min(nums[0], nums[1]);
    const max = Math.max(nums[0], nums[1]);
    return { price: null, min, max, isRange: true };
  }
  return { price: nums[0], min: nums[0], max: nums[0], isRange: false };
}

/** Single price, or null when the value is a range or unparseable. */
export function parsePrice(text) {
  const info = parsePriceInfo(text);
  return info && !info.isRange ? info.price : null;
}

function toNum(v) {
  if (v == null || v === '') return null;
  const m = String(v).match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}
