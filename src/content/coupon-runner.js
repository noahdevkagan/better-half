/* global chrome */
/**
 * Checkout orchestration: find candidate codes, prove them on the real cart,
 * report only what worked.
 */
(() => {
  'use strict';
  const NS = (window.__SD__ = window.__SD__ || {});
  if (!NS.profiles || !NS.verifier) return; // load order guard

  const { detectProfile, readSubtotal } = NS.profiles;
  const { verify } = NS.verifier;

  /**
   * Hosts that run checkout on behalf of many different merchants.
   * Keying the ledger on location.hostname here would file every Shopify
   * store's codes under "shop.app" and then offer Kyte Baby's code to an
   * unrelated shop. We resolve the actual merchant instead.
   */
  const SHARED_CHECKOUT_HOSTS = /^(shop\.app|checkout\.shopify\.com|pay\.shopify\.com|checkout\.stripe\.com)$/;

  function resolveMerchant() {
    const host = location.hostname.replace(/^www\./, '');
    if (!SHARED_CHECKOUT_HOSTS.test(host)) return host;

    // Shop Pay URLs carry a stable numeric shop id: /checkout/<shopId>/cn/...
    const shopId = location.pathname.match(/\/checkout\/(\d+)\//)?.[1];
    if (shopId) return `shopify:${shopId}`;

    // Otherwise fall back to whoever sent us here.
    try {
      const ref = document.referrer && new URL(document.referrer).hostname.replace(/^www\./, '');
      if (ref && !SHARED_CHECKOUT_HOSTS.test(ref)) return ref;
    } catch { /* no usable referrer */ }

    const site = document.querySelector('meta[property="og:site_name"]')?.content;
    return site ? `name:${site.toLowerCase().trim()}` : host;
  }

  const domain = resolveMerchant();

  // Amazon has its own content script and, by design, barely uses typed codes.
  if (/(^|\.)amazon\./.test(location.hostname)) return;

  /**
   * Generic codes worth a try on almost any storefront.
   * This isn't guesswork for its own sake — during validation the plain guess
   * WELCOME20 was the code that actually worked, beating two codes scraped
   * from aggregator sites. They're cheap to test and rank below proven ones.
   */
  const GENERIC = ['WELCOME10', 'WELCOME15', 'WELCOME20', 'SAVE10', 'FIRST10', 'NEW15'];

  /** Codes the merchant is advertising on its own page. */
  function scrapeOnPageCodes() {
    const text = document.body.innerText.slice(0, 20000);
    const found = new Set();
    const patterns = [
      /\bcode[:\s]+([A-Z0-9][A-Z0-9-]{3,19})\b/g,
      /\buse\s+([A-Z0-9][A-Z0-9-]{3,19})\s+at\s+checkout/gi,
    ];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(text)) !== null) {
        const c = m[1].toUpperCase();
        if (!/^(CODE|SHOP|SALE|HERE|FREE|SHIPPING)$/.test(c)) found.add(c);
      }
    }
    return [...found].slice(0, 5);
  }

  // ------------------------------------------------------------------ UI --

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  let banner = null;
  function showBanner(text, variant) {
    if (!banner) {
      banner = el('div', 'sd-banner');
      document.body.appendChild(banner);
    }
    banner.className = `sd-banner${variant ? ` sd-banner--${variant}` : ''}`;
    banner.textContent = text;
    return banner;
  }

  function hideBanner() {
    banner?.remove();
    banner = null;
  }

  // --------------------------------------------------------------- start --

  async function run() {
    const settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }).catch(() => null);
    if (settings && settings.couponsEnabled === false) return;

    const profile = detectProfile();
    if (!profile) return;

    const subtotal = readSubtotal();
    const known = await chrome.runtime
      .sendMessage({ type: 'GET_CODES', domain, subtotal })
      .catch(() => ({ codes: [] }));

    // Ranked best-first. The verifier only has budget for ~6 codes at ~4s each,
    // so ordering matters more than volume:
    //   1. codes already proven on this merchant   (near-certain, free win)
    //   2. codes the merchant advertises itself     (high hit rate)
    //   3. aggregator codes, public before referral (already ranked upstream)
    //   4. cheap generics — WELCOME20 is what actually won on Kyte Baby
    const ranked = dedupe([
      ...(known?.codes || []).map((r) => r.code),
      ...scrapeOnPageCodes(),
      ...(known?.candidates || []).filter((c) => !c.referral).map((c) => c.code),
      ...GENERIC,
      ...(known?.candidates || []).filter((c) => c.referral).map((c) => c.code),
    ]);

    if (!ranked.length) return;

    showBanner('Better Half: testing codes…', 'working');

    const result = await verify(ranked, profile, ({ phase, code }) => {
      if (phase === 'testing') showBanner(`Testing ${code}…`, 'working');
    });

    if (result.error) {
      showBanner(`Better Half: ${result.error}`, 'idle');
      setTimeout(hideBanner, 6000);
      return;
    }

    // Everything learned goes to the ledger, including failures — knowing a
    // code is dead is what stops us wasting the user's time on it next visit.
    chrome.runtime.sendMessage({
      type: 'COUPON_RESULTS',
      domain,
      results: result.results,
    }).catch(() => {});

    if (result.best) {
      showBanner(`Applied ${result.best.code} — you saved $${result.best.saved.toFixed(2)}`, 'win');
    } else {
      const tested = result.results.length;
      showBanner(
        `No working code found (${tested} tested). Your cart is unchanged.`,
        'idle',
      );
      setTimeout(hideBanner, 8000);
    }
  }

  function dedupe(list) {
    const seen = new Set();
    return list.filter((c) => {
      const k = String(c || '').toUpperCase();
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  // Checkouts are SPAs; the promo field often appears after first paint.
  let started = false;
  const kick = () => {
    if (started) return;
    if (!detectProfile()) return;
    started = true;
    run().catch((e) => console.debug('[better-half]', e));
  };

  kick();
  const mo = new MutationObserver(() => kick());
  mo.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => mo.disconnect(), 60000);
})();
