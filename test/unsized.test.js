/**
 * Regressions from the Oura Ring miss.
 *
 * A real Amazon listing (B0GRK5XX1P, $499) had a Target equivalent, and the
 * extension showed nothing. Three independent bugs caused it, and the third
 * would have been worse than silence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeQuantity, parsePrice, parsePriceInfo } from '../src/match/normalize.js';
import { matchConfidence, buildVerdict, TIER, VERDICT } from '../src/match/confidence.js';

const AMZ_OURA = 'Oura Ring 5 - Deep Rose - Size 8 - World’s Smallest Smart Ring - Sleep, Activity, Women’s Health, AI Advisor, 1 Week of Battery Life, Size Before You Buy, Android & iOS Compatible';
const TGT_OURA = 'Oura Ring 5';
const TGT_OURA_FULL = 'Oura Ring 5 Silver Size 10';

const prod = (title, extra = {}) => ({
  title, barcode: null, quantity: normalizeQuantity(title), ...extra,
});

// ------------------------------------------------------- 1. price ranges --

test('a price RANGE is never collapsed to its minimum', () => {
  // The bug: "$399.00 - $499.00" parsed as 399 against Amazon's $499 invents
  // a $100 saving on a variant the shopper may not want.
  const info = parsePriceInfo('$399.00 - $499.00');
  assert.equal(info.isRange, true);
  assert.equal(info.min, 399);
  assert.equal(info.max, 499);
  assert.equal(info.price, null, 'a range is not a single price');
  assert.equal(parsePrice('$399.00 - $499.00'), null);
});

test('ordinary prices still parse normally', () => {
  assert.equal(parsePrice('$54.99'), 54.99);
  assert.equal(parsePrice('$1,190.57'), 1190.57);
  assert.equal(parsePriceInfo('$16.97').isRange, false);
});

test('a range never becomes a CHEAPER_ELSEWHERE saving claim', () => {
  const v = buildVerdict(
    { inStock: true, total: 499, unitPrice: null },
    [{
      tier: TIER.CONFIDENT, inStock: true, total: null, price: null,
      priceRange: [399, 499], retailerName: 'Target',
    }],
  );
  assert.equal(v.verdict, VERDICT.PRICE_VARIES);
  assert.equal(v.saving, undefined, 'must not assert a saving on a range');
  assert.equal(v.best.priceRange[0], 399);
});

test('a range whose low end is not cheaper is not surfaced as a lead', () => {
  const v = buildVerdict(
    { inStock: true, total: 299, unitPrice: null },
    [{
      tier: TIER.CONFIDENT, inStock: true, total: null, price: null,
      priceRange: [399, 499], retailerName: 'Target',
    }],
  );
  assert.equal(v.verdict, VERDICT.NO_VERIFIED_MATCH);
});

// ----------------------------------------------------- 2. unsized goods --

test('an unsized product yields no quantity (this is expected, not a failure)', () => {
  assert.equal(normalizeQuantity(AMZ_OURA, {}), null);
});

test('colour and fitted size do not block a match, but ARE disclosed', () => {
  // Amazon: Deep Rose / Size 8.  Target: Silver / Size 10.
  // Same product, same price tier — the difference is reported, not hidden.
  const m = matchConfidence(prod(AMZ_OURA), prod(TGT_OURA_FULL));
  assert.equal(m.tier, TIER.CONFIDENT, m.reasons.join('; '));
  assert.match(m.variantNote || '', /silver|size 10/i);
});

test('unsized matching still rejects a different product', () => {
  const m = matchConfidence(prod(AMZ_OURA), prod('Fitbit Inspire 3 Activity Tracker'));
  assert.equal(m.tier, TIER.REJECT);
});

test('a parent listing matches its variant', () => {
  const m = matchConfidence(prod(AMZ_OURA), prod(TGT_OURA));
  assert.equal(m.tier, TIER.CONFIDENT);
});

test('product-line discriminators still block, unlike variant attributes', () => {
  // "Sensitive" is a different formula; "silver" is just a finish.
  const a = prod('Similac 360 Total Care Sensitive');
  const b = prod('Similac 360 Total Care Gentle Comfort');
  assert.equal(matchConfidence(a, b).tier, TIER.REJECT);
});

test('sized vs unsized is rejected — we cannot claim they are the same', () => {
  const sized = prod('Similac 360 Total Care Sensitive 30.2oz');
  const unsized = prod('Similac 360 Total Care Sensitive');
  assert.equal(matchConfidence(sized, unsized).tier, TIER.REJECT);
});

test('consumables are unaffected by the unsized path', () => {
  const a = prod('Boudreaux’s Butt Paste Max Strength Diaper Rash Cream 14 oz');
  const b = prod('Boudreaux’s Butt Paste Maximum Strength - 14oz');
  assert.equal(matchConfidence(a, b).tier, TIER.CONFIDENT);
});

// ------------------------------------- 3. the real Target result list ------
//
// These are the actual eight results Target returned for the Oura keyword.
// The $10 "Sizing Kit" is the dangerous one: same brand, same model number,
// and a naive matcher reports a $489 saving on a plastic sizing gauge.

const TARGET_OURA_RESULTS = [
  { title: 'Oura Ring 5 Silver - Size 8', price: 399, shouldMatch: true },
  { title: 'Oura Ring 5 Sizing Kit', price: 10, shouldMatch: false },
  { title: 'Oura Ring 4 Gold - Size 5', price: 399, shouldMatch: false },
  { title: 'Oura Ring 5 Collection', price: null, shouldMatch: false },
  { title: 'RingConn® Gen 2 Ultra-Thin Smart Ring with Sleep Apnea Monitoring', price: 299, shouldMatch: false },
  { title: 'Ultrahuman Ring AIR Sizing Kit', price: 10, shouldMatch: false },
];

test('real Target result list: only the true equivalent matches', () => {
  const src = prod(AMZ_OURA);
  for (const r of TARGET_OURA_RESULTS) {
    const m = matchConfidence(src, prod(r.title));
    const matched = m.tier !== TIER.REJECT;
    assert.equal(matched, r.shouldMatch,
      `"${r.title}" expected ${r.shouldMatch ? 'match' : 'REJECT'}, got tier ${m.tier} (${m.reasons.join('; ')})`);
  }
});

test('the $10 Sizing Kit never becomes a $489 saving', () => {
  const m = matchConfidence(prod(AMZ_OURA), prod('Oura Ring 5 Sizing Kit'));
  assert.equal(m.tier, TIER.REJECT, 'an accessory is not the product');
});

test('a different generation (Ring 4 vs Ring 5) is rejected', () => {
  assert.equal(matchConfidence(prod(AMZ_OURA), prod('Oura Ring 4 Gold - Size 5')).tier, TIER.REJECT);
});

test('end-to-end: the Oura case yields a $100 saving with the finish disclosed', () => {
  const src = { ...prod(AMZ_OURA), inStock: true, total: 499, unitPrice: null };
  const cand = prod('Oura Ring 5 Silver - Size 8');
  const m = matchConfidence(src, cand);
  const v = buildVerdict(src, [{
    ...cand, tier: m.tier, variantNote: m.variantNote,
    inStock: true, total: 399, retailerName: 'Target',
  }]);
  assert.equal(v.verdict, VERDICT.CHEAPER_ELSEWHERE);
  assert.equal(v.saving, 100);
  assert.match(v.best.variantNote, /silver/);
});
