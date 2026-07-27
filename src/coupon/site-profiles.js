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

  const PROMO_RE = /promo|coupon|discount|voucher|reduction/i;

  /**
   * A search box is not a promo field.
   *
   * "Search for coupons" matches PROMO_RE, which is how every coupon
   * aggregator's own search box registered as a checkout — and, because the
   * verifier falls back to pressing Enter when it finds no Apply button, how we
   * ended up submitting searches on pages the user was only reading.
   */
  const SEARCH_RE = /search|query|\bq\b|find|lookup/i;

  function isSearchBox(i) {
    if (i.type === 'search') return true;
    if (i.getAttribute('role') === 'searchbox') return true;
    try {
      if (i.closest('[role="search"], form[role="search"]')) return true;
    } catch { /* stub or exotic DOM */ }
    const hay = `${i.name || ''} ${i.id || ''} ${i.placeholder || ''} ${i.getAttribute('aria-label') || ''}`;
    return SEARCH_RE.test(hay);
  }

  function findGenericInput() {
    const inputs = [...document.querySelectorAll('input[type="text"], input:not([type])')];
    return inputs.find((i) => {
      if (isSearchBox(i)) return false;
      const hay = `${i.name || ''} ${i.id || ''} ${i.placeholder || ''} ${i.getAttribute('aria-label') || ''}`;
      return PROMO_RE.test(hay);
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

  const CHECKOUT_PATH_RE = /(^|\/)(checkouts?|carts?|basket|bag|orders?|payment|billing)(\/|$)/i;

  const APPLY_RE = /\b(apply|redeem|use\s+code|add\s+code)\b/i;

  /** Is there a control next to this input that applies a code? */
  function hasApplyControl(input) {
    if (!input) return false;
    const scopes = [
      input.closest?.('form'),
      input.parentElement,
      input.parentElement?.parentElement,
      input.parentElement?.parentElement?.parentElement,
    ].filter(Boolean);
    for (const scope of scopes) {
      for (const b of scope.querySelectorAll('button, input[type="submit"]')) {
        const l = `${b.textContent || ''} ${b.getAttribute('aria-label') || ''} ${b.value || ''}`;
        if (APPLY_RE.test(l)) return true;
      }
    }
    return false;
  }

  /**
   * Should we actually run the coupon flow on this page?
   *
   * `detectProfile()` answers "is there something shaped like a promo field",
   * which is a much weaker claim than "the user is checking out" — and treating
   * the two as the same is what made this extension type codes into random
   * pages. So we require money to be on the page, and for the catch-all generic
   * profile we require a second, independent signal on top of that.
   */
  function isCheckoutContext(profile) {
    if (!profile) return false;

    // No total and no subtotal means no cart, whatever the inputs look like.
    if (readTotal() == null && readSubtotal() == null) return false;

    // Shopify and BigCommerce identified themselves by platform markers, not by
    // a placeholder regex, so the field is already strong evidence.
    if (profile.id !== 'generic') return true;

    return CHECKOUT_PATH_RE.test(location.pathname) || hasApplyControl(profile.inputEl);
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

  NS.profiles = {
    detectProfile,
    isCheckoutContext,
    readTotal,
    readSubtotal,
    paymentFieldPopulated,
    parseMoney,
  };
})();
