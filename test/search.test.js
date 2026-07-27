/** Search-quality regressions. Titles are real captures. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildKeyword, tokenizeTitle } from '../src/match/keywords.js';
import { __test__ as sources } from '../src/background/coupon-sources.js';

const SIMILAC = 'Similac 360 Total Care Sensitive Baby Formula Powder, 5 HMO Prebiotic Blend | Infant formula for babies with lactose sensitivity; immune system, brain development & digestive health support, 30.2 oz tub';
const BUTTPASTE = 'Boudreaux’s Butt Paste Max Strength Diaper Rash Cream for Baby, Ointment With Zinc Oxide, 14 oz Flip-Top Jar';

test('keeps the product-line number ("360"), drops the size', () => {
  const k = buildKeyword(SIMILAC);
  assert.match(k, /\b360\b/, '"360" identifies the product line and must survive');
  assert.doesNotMatch(k, /30\.2/, 'sizes must not leak into the query');
  assert.doesNotMatch(k, /\boz\b/);
});

test('keeps the variant qualifier that distinguishes near-identical products', () => {
  assert.match(buildKeyword(SIMILAC), /sensitive/,
    'dropping "sensitive" would match plain Total Care instead');
});

test('possessives do not leak a stray single letter', () => {
  const k = buildKeyword(BUTTPASTE);
  assert.doesNotMatch(k, /(^|\s)s(\s|$)/, 'the old builder produced "boudreaux s"');
  assert.match(k, /boudreaux/);
});

test('keeps "max strength" so it cannot match Original Strength', () => {
  const k = buildKeyword(BUTTPASTE);
  assert.match(k, /max/);
  assert.match(k, /strength/);
});

test('a number followed by a unit is treated as a size', () => {
  assert.doesNotMatch(buildKeyword('Acme Widget 12 pack 500 ml bottle'), /\b12\b|\b500\b/);
});

test('a bare number not followed by a unit is kept', () => {
  assert.match(buildKeyword('Enfamil NeuroPro 360 Formula'), /360/);
});

test('tokenizer strips bidi and decodes entities', () => {
  assert.deepEqual(tokenizeTitle('Boudreaux&#39;s Butt Paste'), ['boudreaux', 'butt', 'paste']);
});

test('optional size suffix is appended when asked for', () => {
  assert.match(buildKeyword('Similac 360 Total Care Sensitive', { size: '30.2 oz' }), /30\.2 oz$/);
});

// ------------------------------------------------------------ coupon ranks --

test('referral codes rank last — testing one consumes it', () => {
  const ranked = sources.rankCandidates([
    { code: 'LL-89RBSWZD', note: '20% off' },      // referral, high advertised %
    { code: 'WELCOME15', note: '15% off' },
  ]);
  assert.equal(ranked[0].code, 'WELCOME15');
  assert.equal(ranked[1].referral, true);
});

test('higher advertised discount is tried first among public codes', () => {
  const ranked = sources.rankCandidates([
    { code: 'SAVE5', note: 'Take 5% off your order' },
    { code: 'BIGDEAL', note: 'Get 25% off sitewide' },
  ]);
  assert.equal(ranked[0].code, 'BIGDEAL');
});

test('aggregator site self-promos are filtered out', () => {
  const ranked = sources.rankCandidates([
    { code: 'SIMPLYCODESD', note: '' },
    { code: 'BLBOXWELCOME', note: '10% off' },
  ]);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].code, 'BLBOXWELCOME');
});

test('percent is parsed out of aggregator description text', () => {
  assert.equal(sources.percentFrom('Get 25% off sitewide'), 25);
  assert.equal(sources.percentFrom('Free shipping'), null);
});
