/**
 * Regressions from two real tool listings.
 *
 *   B0DK6HZ93H — model 48-32-4013, brand "LRYXYY", title "…for Milwaukee",
 *                $51.48. Home Depot sells the genuine Milwaukee at $44.99.
 *   B001A4CWHO — Alden 8440P. Amazon flags "High price", states a typical
 *                price of $19.99, and SUPPRESSES the buy box. Its UPC field
 *                holds four codes at once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { barcodesMatch, parseBarcodes, normalizeQuantity } from '../src/match/normalize.js';
import { matchConfidence, modelsMatch, normalizeModel, TIER, VERDICT, buildVerdict } from '../src/match/confidence.js';

const AMZ_MILWAUKEE = {
  title: '48-32-4013 with Shockwave Impact Duty Drill & Drive Set - 50PC，for Milwaukee',
  brand: 'LRYXYY',
  model: '48-32-4013',
  barcode: '711185819034',
  price: 51.48,
};

const HD_MILWAUKEE = {
  title: 'Milwaukee SHOCKWAVE Impact Duty Drill and Alloy Steel Screw Driver Bit Set (50-Piece)',
  brand: 'Milwaukee',
  model: '48-32-4013',
  barcode: null,
  price: 44.99,
};

const prod = (f) => ({
  title: f.title, brand: f.brand, model: f.model, barcode: f.barcode,
  quantity: normalizeQuantity(f.title),
});

// ------------------------------------------------------ model matching --

test('model numbers match across punctuation and case', () => {
  assert.ok(modelsMatch('48-32-4013', '48324013'));
  assert.ok(modelsMatch('dcd771c2', 'DCD771C2'));
});

test('short strings are not treated as model numbers', () => {
  assert.equal(normalizeModel('5'), null);
  assert.equal(normalizeModel('AB'), null);
  assert.ok(!modelsMatch('5', '5'), 'a bare digit must never match everything');
});

test('a shared model number is a strong match even with different titles', () => {
  const m = matchConfidence(prod(AMZ_MILWAUKEE), prod(HD_MILWAUKEE));
  assert.equal(m.tier, TIER.EXACT_MODEL);
});

test('different model numbers do not match on model', () => {
  const other = { ...HD_MILWAUKEE, model: '48-32-4005' };
  const m = matchConfidence(prod(AMZ_MILWAUKEE), prod(other));
  assert.notEqual(m.tier, TIER.EXACT_MODEL);
});

// -------------------------------------------------- brand disclosure --

test('an aftermarket listing is matched but the brand gap is disclosed', () => {
  const m = matchConfidence(prod(AMZ_MILWAUKEE), prod(HD_MILWAUKEE));
  assert.equal(m.tier, TIER.EXACT_MODEL, 'still worth comparing');
  assert.ok(m.brandNote, 'the brand difference must be surfaced');
  assert.equal(m.aftermarket, true, '"…for Milwaukee" marks a compatible listing');
  assert.match(m.brandNote, /LRYXYY/);
  assert.match(m.brandNote, /Milwaukee/);
});

test('matching brands produce no note', () => {
  const a = prod({ ...AMZ_MILWAUKEE, brand: 'Milwaukee' });
  const m = matchConfidence(a, prod(HD_MILWAUKEE));
  assert.equal(m.brandNote, undefined);
});

test('end-to-end: Home Depot undercuts the aftermarket Amazon listing', () => {
  const src = { ...prod(AMZ_MILWAUKEE), inStock: true, total: 51.48, unitPrice: null };
  const m = matchConfidence(src, prod(HD_MILWAUKEE));
  const v = buildVerdict(src, [{
    ...prod(HD_MILWAUKEE), tier: m.tier, brandNote: m.brandNote,
    inStock: true, total: 44.99, retailerName: 'Home Depot',
  }]);
  assert.equal(v.verdict, VERDICT.CHEAPER_ELSEWHERE);
  assert.equal(v.saving, 6.49);
});

// ------------------------------------------------- multi-code UPC field --

test('a UPC field holding several codes is split, not welded together', () => {
  const field = '786830337782 795871624188 744211231548 727708084407';
  const codes = parseBarcodes(field);
  assert.equal(codes.length, 4);
  assert.ok(codes.includes('786830337782'));
});

test('sharing any one barcode counts as a match', () => {
  assert.ok(barcodesMatch('786830337782 795871624188', '795871624188'));
  assert.ok(!barcodesMatch('786830337782 795871624188', '111111111111'));
});

test('the welded-together bug would have matched nothing', () => {
  const welded = '786830337782795871624188744211231548727708084407';
  assert.ok(!barcodesMatch(welded, '786830337782'),
    'proves why splitting matters: the concatenation matches no real code');
});

// ------------------------------------------------------------- shipping --

import * as homedepot from '../src/adapters/homedepot.js';
import * as targetAdapter from '../src/adapters/target.js';

test('scraped shipping always beats the threshold table', () => {
  // The real bug: $44.99 sits one cent under a $45 threshold, so the table
  // added $8.99 of phantom shipping — enough to flip the verdict to Amazon —
  // while the page plainly read "Delivery Tue, Jul 28 — FREE".
  assert.equal(homedepot.shippingFor(44.99, { homeDepotShipToStore: false }, 0), 0);
  assert.equal(targetAdapter.shippingFor(10, {}, 0), 0);
});

test('a scraped non-zero shipping cost is honoured', () => {
  assert.equal(homedepot.shippingFor(20, {}, 8.99), 8.99);
});

test('the threshold table is used only when nothing was scraped', () => {
  assert.equal(homedepot.shippingFor(44.99, { homeDepotShipToStore: false }, null), 8.99);
  assert.equal(targetAdapter.shippingFor(10, {}, null), 5.99);
  assert.equal(targetAdapter.shippingFor(50, {}, null), 0);
});

test('the Milwaukee comparison holds with real scraped shipping', () => {
  const amazon = 51.48 + 0;                                   // free with Prime
  const hd = 44.99 + homedepot.shippingFor(44.99, {}, 0);     // page says FREE
  assert.equal(hd, 44.99);
  assert.equal(Math.round((amazon - hd) * 100) / 100, 6.49);
});

// ------------------------------------------------ one row per retailer -----
//
// From a real card: five identical "Walmart $6.99" rows for an OutdoorMaster
// helmet. Two bugs at once — a retailer's search returns many near-identical
// variants, and Walmart's __NEXT_DATA__ carries price 0, so `0 + 6.99` shipping
// rendered as though the shipping cost were the price.

test('only the best offer per retailer is shown', () => {
  const dupes = Array.from({ length: 5 }, () => ({
    tier: TIER.CONFIDENT, inStock: true, retailer: 'walmart',
    retailerName: 'Walmart', total: 26.99, unitPrice: null,
  }));
  dupes.push({ tier: TIER.CONFIDENT, inStock: true, retailer: 'walmart',
    retailerName: 'Walmart', total: 23.48, unitPrice: null });

  const v = buildVerdict({ inStock: true, total: 26.09, unitPrice: null }, dupes);
  assert.equal(v.offers.length, 1, 'five Walmart rows must collapse to one');
  assert.equal(v.offers[0].total, 23.48, 'and it must be the cheapest');
});

test('distinct retailers each keep a row', () => {
  const v = buildVerdict({ inStock: true, total: 26.09, unitPrice: null }, [
    { tier: TIER.CONFIDENT, inStock: true, retailer: 'walmart', retailerName: 'Walmart', total: 23.48, unitPrice: null },
    { tier: TIER.CONFIDENT, inStock: true, retailer: 'target', retailerName: 'Target', total: 29.99, unitPrice: null },
  ]);
  assert.equal(v.offers.length, 2);
  assert.equal(v.offers[0].retailerName, 'Walmart', 'cheapest first');
});
