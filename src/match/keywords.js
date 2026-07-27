/**
 * Search-keyword construction.
 *
 * Retailer search engines reward short, identifying queries and punish noise.
 * Three bugs the naive version had, all visible on real titles:
 *
 *   1. It stripped every bare number, throwing away "360" in "Similac 360
 *      Total Care" — a core product-line identifier. Sizes must go; line
 *      numbers must stay. We tell them apart by what FOLLOWS the number: a
 *      number followed by a unit is a size.
 *
 *   2. "Boudreaux's" became "boudreaux s", leaking a junk single-letter token
 *      into the query. Possessives are stripped, not spaced.
 *
 *   3. It cut blindly at N tokens, so a long marketing title could spend the
 *      whole budget before reaching the distinguishing words.
 */

import { decodeEntities, stripBidi, stripVariantAttrs } from './normalize.js';

const UNIT_WORD = /^(oz|ozs|ounce|ounces|fl|floz|lb|lbs|pound|pounds|g|kg|gram|grams|ml|l|liter|liters|qt|quart|quarts|ct|count|pk|pack|packs|each)$/;

/** Generic retail filler that never helps a search engine discriminate. */
const FILLER = new Set([
  'baby', 'babies', 'infant', 'the', 'a', 'an', 'and', 'or', 'for', 'with',
  'in', 'of', 'to', 'by', 'on', 'value', 'size', 'new', 'premium', 'tub',
  'can', 'jar', 'bottle', 'flip', 'top', 'non', 'gmo', 'free',
  // Marketing superlatives: pure noise to a retailer's search index, and they
  // burn the token budget before the identifying words are reached.
  'world', 'worlds', 'smallest', 'largest', 'thinnest', 'lightest', 'best',
  'ultimate', 'latest', 'official', 'genuine', 'authentic', 'original',
  'advanced', 'improved', 'upgraded', 'exclusive',
]);

/**
 * Words that strongly identify a product variant. These are protected from the
 * token budget — losing "sensitive" turns a correct search into a wrong one.
 */
const KEEP = /^(sensitive|gentle|comfort|maximum|max|strength|original|organic|hypoallergenic|powder|concentrate|advance|unscented)$/;

export function tokenizeTitle(title, { keepVariants = true } = {}) {
  const base = keepVariants
    ? decodeEntities(stripBidi(title))
    // Searching for "oura ring deep rose" hunts a colour the other retailer
    // may not stock. Search for the product; match the variant afterwards.
    : stripVariantAttrs(title).cleaned;
  return base
    .toLowerCase()
    .replace(/['’]s\b/g, '')        // possessives: boudreaux's -> boudreaux
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9.\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Build a search keyword.
 * @param {string} title
 * @param {object} [opts] { max, size } — pass a size string to append it,
 *   which helps retailers whose relevance ranking uses it.
 */
export function buildKeyword(title, opts = {}) {
  const max = opts.max ?? 6;
  const raw = tokenizeTitle(title, { keepVariants: false });

  const kept = [];
  for (let i = 0; i < raw.length; i += 1) {
    const t = raw[i];
    const next = raw[i + 1];

    // Drop stray single LETTERS (the "s" left by a possessive) but never
    // single digits — "Oura Ring 5" and "PlayStation 5" need theirs.
    if (t.length < 2 && !/^\d$/.test(t)) continue;
    if (UNIT_WORD.test(t)) continue;                  // "oz", "ct"
    if (/^\d+\.\d+$/.test(t)) continue;               // decimals are always sizes
    if (/^\d+$/.test(t)) {
      // A number followed by a unit is a size ("34.9 oz", "3 pk"). Otherwise
      // it's part of the product name ("Similac 360").
      if (next && UNIT_WORD.test(next)) continue;
      if (t.length > 4) continue;                     // long digit runs are SKUs
      kept.push(t);
      continue;
    }
    if (FILLER.has(t)) continue;
    kept.push(t);
  }

  // Spend the budget on leading tokens (brand + line) but never drop a variant
  // qualifier, which is what actually distinguishes near-identical products.
  const head = kept.slice(0, max);
  for (const t of kept.slice(max)) {
    if (KEEP.test(t) && !head.includes(t)) head.push(t);
  }

  const keyword = head.join(' ').trim();
  return opts.size ? `${keyword} ${String(opts.size).toLowerCase()}`.trim() : keyword;
}
