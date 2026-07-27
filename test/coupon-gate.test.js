/**
 * Regression tests for the tab loop.
 *
 * Observed live: with only "is there a promo-shaped input" as a gate, a coupon
 * aggregator's own "Search for coupons" box registered as a checkout. The
 * content script then asked for codes for `couponfollow.com`, the background
 * harvested `couponfollow.com/site/couponfollow.com` in a new tab, the content
 * script loaded in THAT tab and did the same again — tabs opening and closing
 * indefinitely while the user was reading their calendar.
 *
 * `site-profiles.js` is a content script, not a module, so it is evaluated in a
 * vm against a DOM stub. The stub is deliberately small: it implements only the
 * handful of DOM calls these functions make, so a test failure points at the
 * detection logic rather than at a mock framework.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { __test__ } from '../src/background/coupon-sources.js';

const SRC = readFileSync(new URL('../src/coupon/site-profiles.js', import.meta.url), 'utf8');

// ------------------------------------------------------------- DOM stub --

function makeInput(attrs = {}) {
  const el = {
    type: attrs.type ?? 'text',
    name: attrs.name ?? '',
    id: attrs.id ?? '',
    placeholder: attrs.placeholder ?? '',
    value: '',
    role: attrs.role ?? null,
    inSearchLandmark: attrs.inSearchLandmark ?? false,
    ariaLabel: attrs.ariaLabel ?? null,
  };
  el.getAttribute = (n) => {
    if (n === 'aria-label') return el.ariaLabel;
    if (n === 'role') return el.role;
    return null;
  };
  return el;
}

function makeButton(text) {
  return { textContent: text, value: '', getAttribute: () => null };
}

/**
 * @param {object} o
 * @param {string} o.pathname
 * @param {string} o.bodyText     drives readTotal/readSubtotal
 * @param {object[]} o.inputs
 * @param {object[]} o.buttons    siblings of the input, for the apply check
 * @param {boolean} o.shopify     platform marker
 */
function evaluate({
  pathname = '/',
  bodyText = '',
  inputs = [],
  buttons = [],
  shopify = false,
  platformInput = null,
}) {
  // Every input shares one container, which is enough for hasApplyControl's
  // walk up to three parents and its optional form scope.
  const container = { querySelectorAll: () => buttons };
  container.parentElement = null;
  for (const i of inputs) {
    i.parentElement = container;
    i.closest = (sel) => {
      if (sel === 'form') return container;
      if (i.inSearchLandmark && sel.includes('role="search"')) return {};
      return null;
    };
  }

  const document = {
    body: { innerText: bodyText },
    // Only the platform-marker selectors need a real answer; the generic path
    // goes through querySelectorAll instead.
    querySelector: () => platformInput,
    querySelectorAll: () => inputs,
  };

  const window = { Shopify: shopify || undefined };
  const context = vm.createContext({
    window,
    document,
    location: { pathname },
    console,
  });
  vm.runInContext(SRC, context);
  return window.__SD__.profiles;
}

const CART_TEXT = 'Subtotal\n$84.00\nTotal\n$91.50';

// ------------------------------------------------- the aggregator itself --

test('a coupon site search box is not a promo field', () => {
  const p = evaluate({
    pathname: '/site/tidycal.com',
    bodyText: 'Total savings $40.00\nSubtotal\n$12.00',
    inputs: [makeInput({ placeholder: 'Search for coupons', name: 'q' })],
  });
  assert.equal(p.detectProfile(), null);
});

test('an input in a search landmark is rejected even if it says discount', () => {
  const p = evaluate({
    bodyText: CART_TEXT,
    inputs: [makeInput({ placeholder: 'Find a discount', inSearchLandmark: true })],
  });
  assert.equal(p.detectProfile(), null);
});

test('we never harvest an aggregator for its own codes', () => {
  const { AGGREGATOR_HOSTS } = __test__;
  assert.ok(AGGREGATOR_HOSTS.test('couponfollow.com'));
  assert.ok(AGGREGATOR_HOSTS.test('simplycodes.com'));
  assert.ok(!AGGREGATOR_HOSTS.test('tidycal.com'));
  // Must not fire on a merchant whose name merely contains a source name.
  assert.ok(!AGGREGATOR_HOSTS.test('notcouponfollow.com.evil.com'));
});

// ----------------------------------------------------- the context gate --

test('a promo field with no money on the page is not a checkout', () => {
  const p = evaluate({
    pathname: '/settings',
    bodyText: 'Apply a promo code to your account',
    inputs: [makeInput({ name: 'promo_code' })],
  });
  const profile = p.detectProfile();
  assert.ok(profile, 'input should still be detected');
  assert.equal(p.isCheckoutContext(profile), false);
});

test('a promo field with a total but no other signal is still not enough', () => {
  const p = evaluate({
    pathname: '/pricing',
    bodyText: CART_TEXT,
    inputs: [makeInput({ name: 'promo_code' })],
    buttons: [makeButton('Continue')],
  });
  assert.equal(p.isCheckoutContext(p.detectProfile()), false);
});

test('a checkout path plus a total runs', () => {
  const p = evaluate({
    pathname: '/checkout',
    bodyText: CART_TEXT,
    inputs: [makeInput({ name: 'promo_code' })],
  });
  assert.equal(p.isCheckoutContext(p.detectProfile()), true);
});

test('an Apply button next to the field runs, without a checkout path', () => {
  const p = evaluate({
    pathname: '/store/bag',
    bodyText: CART_TEXT,
    inputs: [makeInput({ placeholder: 'Coupon code' })],
    buttons: [makeButton('Apply')],
  });
  assert.equal(p.isCheckoutContext(p.detectProfile()), true);
});

test('Shopify checkout is not held to the generic profile bar', () => {
  const input = makeInput({ name: 'reductions' });
  const p = evaluate({
    pathname: '/checkouts/cn/abc123',
    bodyText: CART_TEXT,
    inputs: [input],
    platformInput: input,
    shopify: true,
  });
  const profile = p.detectProfile();
  assert.equal(profile.id, 'shopify');
  assert.equal(p.isCheckoutContext(profile), true);
});

test('Shopify checkout with no readable total is skipped', () => {
  const input = makeInput({ name: 'reductions' });
  const p = evaluate({
    pathname: '/checkouts/cn/abc123',
    bodyText: 'Loading…',
    inputs: [input],
    platformInput: input,
    shopify: true,
  });
  assert.equal(p.isCheckoutContext(p.detectProfile()), false);
});
