/* eslint-disable no-unused-vars */
/**
 * Per-platform selectors for the checkout surfaces we drive.
 *
 * Validated live against Shopify's current one-page checkout. Two findings
 * shaped this file:
 *
 *   - The applied-discount chip is NOT reliably targetable. Shopify obfuscates
 *     its class names, and the code string never appears in a discount row, so
 *     `[class*="discount"]` finds nothing. The only dependable success signal
 *     is the ORDER TOTAL changing. Every profile therefore reads a total, and
 *     classification is done by comparison, never by looking for a label.
 *
 *   - Removal is a button with aria-label "remove", not a form action.
 */
(() => {
  'use strict';
  const NS = (window.__SD__ = window.__SD__ || {});

  const PROFILES = [
    {
      id: 'shopify',
      detect: () => !!window.Shopify
        || /\/checkouts\/(cn|c)\//.test(location.pathname)
        || !!document.querySelector('input[name="reductions"], #checkout_reduction_code'),
      promoInput: 'input[name="reductions"], input[name="discount"], #checkout_reduction_code, input[name="checkout[reduction_code]"]',
      submit: 'button[type="submit"]',
      removeButton: 'button[aria-label*="remove" i], button[aria-label*="delete" i]',
      errorText: /(enter a valid discount code|discount code isn.?t available|can.?t use this discount|expired|not valid|unable to find)/i,
      rateLimitText: /(too many attempts|try again later|temporarily unavailable)/i,
    },
    {
      id: 'bigcommerce',
      detect: () => !!document.querySelector('[data-test="redeemable-label"], .redeemable-label')
        || /\/checkout/.test(location.pathname) && !!document.querySelector('#redeemableCode'),
      promoInput: '#redeemableCode, input[name="redeemableCode"]',
      submit: '[data-test="redeemableEntry-submit"], button[type="submit"]',
      removeButton: 'button[aria-label*="remove" i], .redeemable-remove',
      errorText: /(invalid|not valid|expired|cannot be applied)/i,
      rateLimitText: /(too many|try again later)/i,
    },
    {
      // Last resort: any page with something that smells like a promo field.
      id: 'generic',
      detect: () => !!findGenericInput(),
      promoInput: null, // resolved dynamically
      submit: 'button[type="submit"]',
      removeButton: 'button[aria-label*="remove" i]',
      errorText: /(invalid|not valid|expired|cannot be applied|isn.?t available)/i,
      rateLimitText: /(too many|try again later)/i,
    },
  ];

  function findGenericInput() {
    const inputs = [...document.querySelectorAll('input[type="text"], input:not([type])')];
    return inputs.find((i) => {
      const hay = `${i.name || ''} ${i.id || ''} ${i.placeholder || ''} ${i.getAttribute('aria-label') || ''}`;
      return /promo|coupon|discount|voucher|reduction/i.test(hay);
    }) || null;
  }

  /** The active profile for this page, or null if there's no promo field. */
  function detectProfile() {
    for (const p of PROFILES) {
      try {
        if (p.detect()) {
          const input = p.promoInput
            ? document.querySelector(p.promoInput) || findGenericInput()
            : findGenericInput();
          if (input) return { ...p, inputEl: input };
        }
      } catch { /* a detect() throwing must not break the others */ }
    }
    return null;
  }

  /**
   * Read the order total.
   * Selector-first, then a text scan — the text scan is what actually worked on
   * Shopify's obfuscated checkout during validation, so it is a first-class
   * path, not a desperate fallback.
   */
  function readTotal() {
    const selectors = [
      '[data-checkout-payment-due-target]',
      '[data-test="cart-price-grandTotal"]',
      '.payment-due__price',
      '#checkout-payment-due',
    ];
    for (const s of selectors) {
      const el = document.querySelector(s);
      const n = parseMoney(el?.textContent);
      if (n != null) return n;
    }
    const text = document.body.innerText;
    const patterns = [
      /Total\s*\n?\s*USD\s*\$?([\d,]+\.\d{2})/i,
      /Order total\s*\n?\s*\$?([\d,]+\.\d{2})/i,
      /\bTotal\b\s*\n?\s*\$?([\d,]+\.\d{2})/i,
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m) return Number(m[1].replace(/,/g, ''));
    }
    return null;
  }

  function readSubtotal() {
    const m = document.body.innerText.match(/Subtotal\s*\n?\s*\$?([\d,]+\.\d{2})/i);
    return m ? Number(m[1].replace(/,/g, '')) : null;
  }

  function parseMoney(s) {
    if (!s) return null;
    const m = String(s).replace(/,/g, '').match(/(\d+(?:\.\d{2}))/);
    return m ? Number(m[1]) : null;
  }

  /**
   * Is a payment field already filled in?
   *
   * NOTE: we deliberately do NOT abort merely because card fields EXIST.
   * Shopify's one-page checkout renders the discount box and the card fields on
   * the same page, so "abort if card fields are present" would disable this
   * feature on essentially every Shopify store. We abort only if the user has
   * actually entered payment details, and we never click the pay button.
   */
  function paymentFieldPopulated() {
    const sel = 'input[name*="card" i], input[name*="cardnumber" i], input[autocomplete="cc-number"], input[name*="cvv" i], input[name*="securityCode" i]';
    for (const el of document.querySelectorAll(sel)) {
      if (el.value && el.value.replace(/\s/g, '').length >= 4) return true;
    }
    // Card fields are usually cross-origin iframes; treat a filled-looking
    // frame count as unknown rather than blocking.
    return false;
  }

  NS.profiles = { detectProfile, readTotal, readSubtotal, paymentFieldPopulated, parseMoney };
})();
