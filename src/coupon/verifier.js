/**
 * The verification loop — the reason this extension exists.
 *
 * Nothing is ever shown to the user that hasn't just been proven on their own
 * cart. Coupon validity is cart-specific (minimum spend, excluded brands,
 * new-customer-only), so "someone else said it worked" is not evidence.
 *
 * Three constraints shape the implementation, all learned on a live checkout:
 *
 *   1. NEVER CLICK PAY. The discount form's submit button sits on the same page
 *      as the order button. We resolve the submit target strictly within the
 *      discount field's own container and refuse anything whose label looks
 *      like a purchase action.
 *
 *   2. DON'T BURN SINGLE-USE CODES. Aggregators list per-account codes that are
 *      consumed by being tested. So we rank candidates by expected value and
 *      stop at the first success that clears a threshold, rather than applying
 *      a winner, stripping it, and hunting for a marginally better one.
 *
 *   3. ~4 SECONDS PER CODE, SERIAL. There is only one cart, so this can't be
 *      parallelised. We poll for the outcome instead of sleeping a fixed
 *      interval, and cap the candidate list.
 */
(() => {
  'use strict';
  const NS = (window.__SD__ = window.__SD__ || {});
  const { readTotal, readSubtotal, paymentFieldPopulated } = NS.profiles;

  const OUTCOME = {
    SUCCESS: 'SUCCESS',
    REJECTED: 'REJECTED',
    NO_OP: 'NO_OP',
    RATE_LIMITED: 'RATE_LIMITED',
  };

  const MAX_CANDIDATES = 6;
  const SETTLE_TIMEOUT_MS = 6000;
  const POLL_MS = 250;
  const GOOD_ENOUGH_PCT = 10; // stop hunting once we clear this

  const PURCHASE_LABEL = /\b(pay|pay now|complete order|place order|buy now|submit order|checkout now)\b/i;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * React (and Vue) controlled inputs ignore a plain `.value =` assignment —
   * the framework's own state never updates and the change is discarded on the
   * next render. The native setter plus dispatched events is what actually
   * works; verified on Shopify's checkout.
   */
  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value')
      || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    desc.set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** Find the apply button WITHOUT ever returning a purchase button. */
  function resolveSubmit(input) {
    const scopes = [
      input.closest('form'),
      input.parentElement,
      input.parentElement?.parentElement,
      input.parentElement?.parentElement?.parentElement,
    ].filter(Boolean);

    for (const scope of scopes) {
      const buttons = [...scope.querySelectorAll('button, input[type="submit"]')];
      const safe = buttons.filter((b) => !PURCHASE_LABEL.test(label(b)));
      const apply = safe.find((b) => /apply|redeem|add/i.test(label(b)));
      if (apply) return apply;
      if (safe.length === 1) return safe[0];
    }
    return null; // fall back to pressing Enter in the field
  }

  function label(btn) {
    return `${btn.textContent || ''} ${btn.getAttribute('aria-label') || ''} ${btn.value || ''}`.trim();
  }

  function submitCode(input, profile) {
    const btn = resolveSubmit(input);
    if (btn) {
      btn.click();
      return;
    }
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    input.form?.requestSubmit?.();
  }

  /**
   * Wait for the page to settle after submitting a code.
   * Polls rather than sleeping a fixed interval, so a fast rejection doesn't
   * cost the user four seconds of standing at the checkout.
   */
  async function awaitOutcome(baselineTotal, profile) {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    let lastTotal = baselineTotal;

    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      const text = document.body.innerText;

      if (profile.rateLimitText?.test(text)) {
        return { outcome: OUTCOME.RATE_LIMITED, total: readTotal() };
      }
      const errMatch = text.match(profile.errorText);
      if (errMatch) {
        return { outcome: OUTCOME.REJECTED, total: readTotal(), message: errMatch[0].slice(0, 100) };
      }

      const now = readTotal();
      if (now != null && baselineTotal != null && now < baselineTotal - 0.001) {
        // Let it stabilise — some checkouts animate the total downward.
        await sleep(POLL_MS);
        return { outcome: OUTCOME.SUCCESS, total: readTotal() ?? now };
      }
      lastTotal = now ?? lastTotal;
    }
    return { outcome: OUTCOME.NO_OP, total: lastTotal };
  }

  async function removeApplied(profile) {
    const btn = document.querySelector(profile.removeButton);
    if (!btn) return false;
    btn.click();
    await sleep(1200);
    return true;
  }

  /**
   * Test candidate codes against the live cart.
   *
   * @param {string[]} codes    ranked best-first by the caller
   * @param {object}   profile  from site-profiles.detectProfile()
   * @param {function} onProgress
   * @returns {Promise<{best, results, baseline, restored}>}
   */
  async function verify(codes, profile, onProgress = () => {}) {
    const input = profile.inputEl;
    const baseline = readTotal();
    const subtotal = readSubtotal() ?? baseline;
    const results = [];

    if (baseline == null) {
      return { error: 'could not read an order total', results, baseline: null };
    }
    if (paymentFieldPopulated()) {
      return { error: 'payment details already entered — not touching this page', results, baseline };
    }

    let best = null;

    try {
      for (const code of codes.slice(0, MAX_CANDIDATES)) {
        onProgress({ phase: 'testing', code });

        setNativeValue(input, code);
        await sleep(150);
        submitCode(input, profile);

        const res = await awaitOutcome(baseline, profile);
        const saved = res.outcome === OUTCOME.SUCCESS && res.total != null
          ? round2(baseline - res.total)
          : 0;
        const pct = saved > 0 && baseline ? round2((saved / baseline) * 100) : 0;

        results.push({
          code,
          outcome: res.outcome,
          discountPct: pct || null,
          saved,
          cartSubtotal: subtotal,
          message: res.message || null,
        });

        if (res.outcome === OUTCOME.RATE_LIMITED) {
          onProgress({ phase: 'rate-limited' });
          break;
        }

        if (res.outcome === OUTCOME.SUCCESS) {
          if (!best || saved > best.saved) best = { code, saved, total: res.total, pct };
          // Stop here rather than stripping a possibly single-use winner to
          // chase a marginal improvement.
          if (pct >= GOOD_ENOUGH_PCT) {
            onProgress({ phase: 'good-enough', code, saved });
            break;
          }
          // Keep the winner applied and stop; see constraint 2 above.
          break;
        }

        // Failed codes leave nothing applied, but clear the field before the
        // next attempt so we never submit a concatenated value.
        setNativeValue(input, '');
        await sleep(120);
      }
    } catch (e) {
      // Whatever happened, the cart must not be left half-modified.
      await restoreIfNeeded(baseline, profile);
      return { error: String(e?.message || e), results, baseline, restored: true };
    }

    const restored = best ? false : await restoreIfNeeded(baseline, profile);
    return { best, results, baseline, restored };
  }

  /**
   * Put the cart back exactly as we found it.
   * Restoration is CONFIRMED by re-reading the total, never assumed.
   */
  async function restoreIfNeeded(baseline, profile) {
    const now = readTotal();
    if (now == null || Math.abs(now - baseline) < 0.001) return true;
    await removeApplied(profile);
    const after = readTotal();
    return after != null && Math.abs(after - baseline) < 0.001;
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  NS.verifier = { verify, OUTCOME, setNativeValue, resolveSubmit, MAX_CANDIDATES };
})();
