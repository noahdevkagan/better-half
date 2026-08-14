import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shippingFor, buildKeyword, RETAILER } from '../src/adapters/costco.js';
import { __test__ as amazonPrice } from '../src/background/amazon-price.js';

test('Costco is identified as its own retailer', () => {
  assert.equal(RETAILER.id, 'costco');
  assert.equal(RETAILER.name, 'Costco');
});

test('Costco never guesses an unknown shipping charge', () => {
  assert.equal(shippingFor(55.99, {}, null), null);
  assert.equal(shippingFor(55.99, {}, 0), 0);
  assert.equal(shippingFor(55.99, {}, 7.50), 7.50);
});

test('Costco uses the same product-focused query builder', () => {
  assert.equal(
    buildKeyword('Similac 360 Total Care Sensitive Infant Formula 30.2oz'),
    'similac 360 total care sensitive formula',
  );
});

test('Amazon history checks are capped to a bounded number of purchases', () => {
  assert.equal(amazonPrice.MAX_ITEMS, 30);
});

test('purchase price arithmetic rounds to cents', () => {
  assert.equal(amazonPrice.round2(26.90 - 23.48), 3.42);
});
