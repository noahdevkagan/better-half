/**
 * Every title and barcode in this file was captured from a live retailer page
 * during design validation. They are not invented fixtures — each one caused,
 * or nearly caused, a real bug.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FAMILY, normalizeQuantity, unitPrice, barcodesMatch, normalizeBarcode, parsePrice,
} from '../src/match/normalize.js';
import { matchConfidence, buildVerdict, TIER, VERDICT } from '../src/match/confidence.js';

// ---------------------------------------------------------------- fixtures --

const AMZ_SIMILAC_3PK = {
  title: 'Similac 360 Total Care Sensitive Baby Formula Powder, 5 HMO Prebiotic Blend | Infant formula for babies with lactose sensitivity; immune system, brain development & digestive health support, 34.9 oz, 3pk',
  structured: { unitCount: '104.7 Ounce', numberOfItems: '3', eachUnitCount: '34.9', size: '34.9 Ounce (Pack of 3)' },
  barcode: '070074681207',
  price: 190.57,
};

const AMZ_SIMILAC_1PK = {
  title: 'Similac 360 Total Care Sensitive Baby Formula Powder, 5 HMO Prebiotic Blend | Infant formula for babies with lactose sensitivity; immune system, brain development & digestive health support, 30.2 oz tub',
  structured: { size: '30.2 Ounce (Pack of 1)' },
  barcode: '070074681238',
  price: null, // Currently unavailable on Amazon
};

const TGT_SIMILAC_302 = {
  title: 'Similac 360 Total Care Sensitive Non-GMO Infant Formula: Kosher, Halal Certified, Milk-Based, Gluten-Free, 30.2oz',
  barcode: '070074681238',
  price: 54.99,
};

const TGT_SIMILAC_RTF_32 = {
  title: 'Similac 360 Total Care Sensitive Non-GMO Ready to Feed Infant Formula - 32 fl oz',
  price: 12.69,
};

const TGT_SIMILAC_RTF_2OZ_12CT = {
  title: 'Similac 360 Total Care Sensitive Non-GMO Ready to Feed Powder Infant Formula - 2 fl oz Each/12ct',
  price: 9.99,
};

const TGT_SIMILAC_PLAIN_308 = {
  title: 'Similac 360 Total Care Non-GMO Infant Formula Powder - 30.8oz: Kosher, Halal, Gluten-Free, Mix',
  price: 49.99,
};

const TGT_SIMILAC_GENTLE_298 = {
  title: 'Similac 360 Total Care Gentle Comfort Powder Infant Formula - 29.8oz',
  price: 49.99,
};

const TGT_SIMILAC_201 = {
  title: 'Similac 360 Total Care Sensitive Non-GMO Powder Infant Formula - 20.1oz: Unflavored, Kosher, Ha',
  price: 38.49,
};

const AMZ_BUTTPASTE = {
  title: 'Boudreaux’s Butt Paste Max Strength Diaper Rash Cream for Baby, Ointment With Zinc Oxide, 14 oz Flip-Top Jar',
  barcode: '362103001941',
  price: 16.97,
};

const TGT_BUTTPASTE = {
  title: 'Boudreaux&#39;s Butt Paste Baby Diaper Rash Cream Maximum Strength - 14oz',
  barcode: '362103001941',
  price: 16.99,
};

const TGT_BUTTPASTE_SENSITIVE = {
  title: 'Boudreaux&#39;s Butt Paste Baby Diaper Rash Cream for Sensitive Skin - 4oz',
  price: 6.99,
};

const TGT_UPUP_GENERIC = {
  title: 'Maximum Strength Diaper Rash Paste - 16oz - up&#38;up&#8482;',
  price: 9.99,
};

const q = (f) => normalizeQuantity(f.title, f.structured || {});
const prod = (f) => ({ title: f.title, barcode: f.barcode, quantity: q(f) });

// ------------------------------------------------------------ normalization --

test('parses a 3-pack from Amazon structured fields', () => {
  const r = q(AMZ_SIMILAC_3PK);
  assert.equal(r.family, FAMILY.WEIGHT);
  assert.equal(r.each, 34.9);
  assert.equal(r.count, 3);
  assert.equal(r.total, 104.7);
});

test('parses a single tub', () => {
  const r = q(AMZ_SIMILAC_1PK);
  assert.equal(r.family, FAMILY.WEIGHT);
  assert.equal(r.total, 30.2);
  assert.equal(r.count, 1);
});

test('parses a size glued to the unit ("30.2oz")', () => {
  const r = q(TGT_SIMILAC_302);
  assert.equal(r.family, FAMILY.WEIGHT);
  assert.equal(r.total, 30.2);
});

test('CRITICAL: "32 fl oz" is volume, never 32 ounces of powder', () => {
  const r = q(TGT_SIMILAC_RTF_32);
  assert.equal(r.family, FAMILY.VOLUME, 'fl oz must not be parsed as weight');
  assert.equal(r.unitLabel, 'fl oz');
  assert.equal(r.total, 32);
});

test('parses "2 fl oz Each/12ct" as 24 fl oz total', () => {
  const r = q(TGT_SIMILAC_RTF_2OZ_12CT);
  assert.equal(r.family, FAMILY.VOLUME);
  assert.equal(r.each, 2);
  assert.equal(r.count, 12);
  assert.equal(r.total, 24);
});

test('unit price divides by total quantity, not pack price', () => {
  assert.equal(unitPrice(190.57, q(AMZ_SIMILAC_3PK)), 1.8202);
  assert.equal(unitPrice(54.99, q(TGT_SIMILAC_302)), 1.8209);
});

test('GTIN-14 and UPC-12 for the same item compare equal', () => {
  assert.ok(barcodesMatch('00070074681238', '070074681238'));
  assert.equal(normalizeBarcode('00070074681238'), normalizeBarcode('070074681238'));
});

test('different pack sizes carry different barcodes', () => {
  assert.ok(!barcodesMatch('070074681207', '070074681238'));
});

test('parsePrice handles $ and thousands separators', () => {
  assert.equal(parsePrice('$1,190.57'), 1190.57);
  assert.equal(parsePrice('$16.97'), 16.97);
  assert.equal(parsePrice(null), null);
});

// ------------------------------------------------------------------ matching --

test('tier 1: identical barcode across retailers (validated live)', () => {
  const r = matchConfidence(prod(AMZ_SIMILAC_1PK), prod(TGT_SIMILAC_302));
  assert.equal(r.tier, TIER.EXACT_BARCODE);
});

test('tier 1: Butt Paste matches on barcode despite different title wording', () => {
  const r = matchConfidence(prod(AMZ_BUTTPASTE), prod(TGT_BUTTPASTE));
  assert.equal(r.tier, TIER.EXACT_BARCODE);
});

test('tier 2: "Max Strength" and "Maximum Strength" are the same product', () => {
  const src = { ...prod(AMZ_BUTTPASTE), barcode: null };
  const cand = { ...prod(TGT_BUTTPASTE), barcode: null };
  const r = matchConfidence(src, cand);
  assert.equal(r.tier, TIER.CONFIDENT, r.reasons.join('; '));
});

test('different pack sizes are unit-comparable, NEVER total-comparable', () => {
  const src = prod(AMZ_SIMILAC_3PK);          // 104.7 oz
  const cand = prod(TGT_SIMILAC_302);         // 30.2 oz
  const m = matchConfidence(src, cand);
  assert.equal(m.tier, TIER.EQUIVALENT_UNIT);
  assert.notEqual(m.tier, TIER.CONFIDENT, 'must not permit a total-price comparison');
  assert.notEqual(m.tier, TIER.EXACT_BARCODE);
});

test('34.9oz vs 20.1oz never produces a total comparison', () => {
  const src = { ...prod(AMZ_SIMILAC_1PK), barcode: null };
  const m = matchConfidence(src, prod(TGT_SIMILAC_201));
  assert.equal(m.tier, TIER.EQUIVALENT_UNIT);
});

test('REGRESSION: a 3-pack must never report a fake saving against a single tub', () => {
  // Amazon 104.7oz @ $190.57 ($1.82/oz) vs Target 30.2oz @ $54.99 ($1.82/oz).
  // Comparing TOTALS would invent a $135 "saving". Comparing units finds none.
  const v = buildVerdict(
    { inStock: true, total: 190.57, unitPrice: 1.8202 },
    [{ tier: TIER.EQUIVALENT_UNIT, inStock: true, total: 54.99, unitPrice: 1.8209, retailer: 'Target' }],
  );
  assert.equal(v.comparedBy, 'unit');
  assert.equal(v.verdict, VERDICT.NO_SAVING);
  assert.equal(v.saving, 0);
});

test('unit comparison reports a real per-ounce win', () => {
  const v = buildVerdict(
    { inStock: true, total: 63.0, unitPrice: 2.1 },
    [{ tier: TIER.EQUIVALENT_UNIT, inStock: true, total: 50.0, unitPrice: 1.6, retailer: 'Walmart' }],
  );
  assert.equal(v.verdict, VERDICT.CHEAPER_ELSEWHERE);
  assert.equal(v.comparedBy, 'unit');
});

test('REJECT: "Sensitive" never matches plain "Total Care"', () => {
  const src = { ...prod(AMZ_SIMILAC_1PK), barcode: null };
  const r = matchConfidence(src, prod(TGT_SIMILAC_PLAIN_308));
  assert.equal(r.tier, TIER.REJECT);
});

test('REJECT: "Sensitive" never matches "Gentle Comfort"', () => {
  const src = { ...prod(AMZ_SIMILAC_1PK), barcode: null };
  assert.equal(matchConfidence(src, prod(TGT_SIMILAC_GENTLE_298)).tier, TIER.REJECT);
});

test('REJECT: powder never compares against ready-to-feed liquid', () => {
  const src = { ...prod(AMZ_SIMILAC_1PK), barcode: null };
  const r = matchConfidence(src, prod(TGT_SIMILAC_RTF_32));
  assert.equal(r.tier, TIER.REJECT, 'weight must not compare against volume');
});

test('REJECT: store-brand lookalike is not the branded product', () => {
  const src = { ...prod(AMZ_BUTTPASTE), barcode: null };
  assert.equal(matchConfidence(src, prod(TGT_UPUP_GENERIC)).tier, TIER.REJECT);
});

test('REJECT: same brand, different variant (Max Strength vs Sensitive Skin)', () => {
  const src = { ...prod(AMZ_BUTTPASTE), barcode: null };
  assert.equal(matchConfidence(src, prod(TGT_BUTTPASTE_SENSITIVE)).tier, TIER.REJECT);
});

test('differing barcodes are noted but do not force a rejection', () => {
  const r = matchConfidence(prod(AMZ_SIMILAC_3PK), prod(TGT_SIMILAC_302));
  assert.equal(r.tier, TIER.EQUIVALENT_UNIT);
  assert.match(r.reasons.join(' '), /different SKU/);
});

// ------------------------------------------------------------------ verdicts --

test('verdict: 2-cent gap is NO_SAVING, not a win (real Butt Paste case)', () => {
  const v = buildVerdict(
    { inStock: true, total: 16.97 },
    [{ tier: TIER.EXACT_BARCODE, inStock: true, total: 16.99, retailer: 'Target' }],
  );
  assert.equal(v.verdict, VERDICT.NO_SAVING);
});

test('verdict: identical unit price is NO_SAVING (real Similac 3-pack case)', () => {
  const v = buildVerdict(
    { inStock: true, total: 190.57 },
    [{ tier: TIER.CONFIDENT, inStock: true, total: 190.6, retailer: 'Target' }],
  );
  assert.equal(v.verdict, VERDICT.NO_SAVING);
});

test('verdict: out of stock here, available there (real Similac 1-pack case)', () => {
  const v = buildVerdict(
    { inStock: false, total: null },
    [{ tier: TIER.EXACT_BARCODE, inStock: true, total: 54.99, retailer: 'Target' }],
  );
  assert.equal(v.verdict, VERDICT.UNAVAILABLE_HERE_AVAILABLE_THERE);
  assert.equal(v.best.total, 54.99);
});

test('verdict: a genuine gap is reported with the saving', () => {
  const v = buildVerdict(
    { inStock: true, total: 63.0 },
    [{ tier: TIER.EXACT_BARCODE, inStock: true, total: 50.0, retailer: 'Walmart' }],
  );
  assert.equal(v.verdict, VERDICT.CHEAPER_ELSEWHERE);
  assert.equal(v.saving, 13);
});

test('verdict: nothing verified shows NO_VERIFIED_MATCH, never a guess', () => {
  const v = buildVerdict(
    { inStock: true, total: 63.0 },
    [{ tier: TIER.REJECT, inStock: true, total: 9.99, retailer: 'Target' }],
  );
  assert.equal(v.verdict, VERDICT.NO_VERIFIED_MATCH);
  assert.equal(v.offers.length, 0);
});
