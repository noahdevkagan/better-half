/* global chrome */
/**
 * User-invoked Amazon order-history price check.
 *
 * Order numbers and purchases are held in memory for this scan only. Nothing
 * is persisted or sent anywhere except to this extension's local worker.
 */
(() => {
  'use strict';

  const pendingKey = 'better-half-order-scan-pending';
  const requested = location.hash === '#better-half-scan' || sessionStorage.getItem(pendingKey) === '1';
  if (!requested) return;
  if (/\/ap\/signin/i.test(location.pathname)) {
    // Amazon may drop the hash during sign-in. Same-origin session storage lets
    // the redirected order page resume without keeping any purchase data.
    sessionStorage.setItem(pendingKey, '1');
    return;
  }
  if (!/\/gp\/your-account\/order-history|\/your-orders/i.test(location.pathname)) return;
  sessionStorage.removeItem(pendingKey);

  const CUTOFF_MS = 30 * 86400_000;
  const MAX_PAGES = 5;
  const MAX_ITEMS = 30;
  const clean = (value) => String(value || '').replace(/[‎‏؜‪-‮]/g, '').replace(/\s+/g, ' ').trim();
  const money = (value) => value == null ? '—' : `$${Number(value).toFixed(2)}`;

  function parseMoney(text) {
    const match = clean(text).match(/\$\s*([\d,]+(?:\.\d{2})?)/);
    return match ? Number(match[1].replace(/,/g, '')) : null;
  }

  function parseOrderDate(text) {
    const normalized = clean(text);
    const match = normalized.match(/(?:ORDER PLACED|Order placed)\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/i)
      || normalized.match(/\b([A-Z][a-z]+\s+\d{1,2},\s+\d{4})\b/);
    if (!match) return null;
    const date = new Date(match[1]);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function asinFrom(href) {
    return (String(href || '').match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i) || [])[1]?.toUpperCase() || null;
  }

  function findPriceNear(link) {
    let node = link;
    for (let i = 0; i < 6 && node; i += 1, node = node.parentElement) {
      const text = clean(node.innerText);
      if (text.length > 1800) break;
      const amounts = [...text.matchAll(/\$\s*([\d,]+(?:\.\d{2})?)/g)]
        .map((match) => Number(match[1].replace(/,/g, '')))
        .filter((value) => Number.isFinite(value));
      if (amounts.length && !/Order Total|Grand Total|Shipping|Tax:/i.test(text)) return amounts[0];
    }
    return null;
  }

  function itemAnchors(root) {
    return [...root.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]')]
      .filter((link) => asinFrom(link.href) && clean(link.innerText).length > 2);
  }

  function orderCards(doc) {
    const selectors = [
      '.order-card',
      '.js-order-card',
      '[data-order-id]',
      '.a-box-group.order',
      '.a-box-group.a-spacing-base',
    ];
    const cards = [...doc.querySelectorAll(selectors.join(','))]
      .filter((card) => /ORDER PLACED|Order placed/i.test(card.innerText || '') && itemAnchors(card).length);
    return [...new Set(cards)];
  }

  function parseOrderPage(doc, pageUrl) {
    const orders = [];
    for (const card of orderCards(doc)) {
      const text = clean(card.innerText);
      if (/Order cancelled|Order canceled|Refund issued|Return complete/i.test(text)) continue;
      const date = parseOrderDate(text);
      const orderId = (text.match(/(?:ORDER\s*#|Order number)\s*([0-9-]{10,})/i) || [])[1] || null;
      const detailLink = [...card.querySelectorAll('a[href]')].find((link) =>
        /order-details|order-summary|summary\/edit/i.test(link.href || ''));
      const anchors = itemAnchors(card);
      const seen = new Set();
      const items = [];
      for (const link of anchors) {
        const asin = asinFrom(link.href);
        if (!asin || seen.has(asin)) continue;
        seen.add(asin);
        items.push({ asin, title: clean(link.innerText), originalPrice: findPriceNear(link) });
      }
      orders.push({
        orderId,
        orderDate: date?.toISOString() || null,
        detailUrl: detailLink ? new URL(detailLink.href, pageUrl).href : null,
        items,
      });
    }
    return orders;
  }

  function parseDetailPage(doc, order) {
    const anchors = itemAnchors(doc);
    const found = new Map();
    for (const link of anchors) {
      const asin = asinFrom(link.href);
      if (!asin || found.has(asin)) continue;
      found.set(asin, {
        asin,
        title: clean(link.innerText),
        originalPrice: findPriceNear(link),
      });
    }

    // A single-item order can safely use Item(s) Subtotal when the line price
    // is absent. Order Total is deliberately never used because it includes tax.
    if (found.size === 1) {
      const body = clean(doc.body?.innerText);
      const subtotal = body.match(/Item\(s\) Subtotal:\s*(\$[\d,]+(?:\.\d{2})?)/i);
      const only = [...found.values()][0];
      if (only.originalPrice == null && subtotal) only.originalPrice = parseMoney(subtotal[1]);
    }

    return order.items.map((item) => {
      const detail = found.get(item.asin);
      return {
        ...item,
        title: detail?.title || item.title,
        originalPrice: detail?.originalPrice ?? item.originalPrice,
      };
    });
  }

  function nextPageUrl(doc, currentUrl) {
    const next = doc.querySelector('li.a-last:not(.a-disabled) a[href], .a-pagination .a-last a[href]')
      || [...doc.querySelectorAll('a[href]')].find((link) => /^Next$/i.test(clean(link.innerText)));
    return next ? new URL(next.getAttribute('href'), currentUrl).href : null;
  }

  async function fetchDocument(url) {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error(`Amazon returned ${response.status}`);
    const html = await response.text();
    return new DOMParser().parseFromString(html, 'text/html');
  }

  async function collectRecentItems(setStatus) {
    const cutoff = Date.now() - CUTOFF_MS;
    let doc = document;
    let pageUrl = location.href;
    const orders = [];

    for (let page = 0; page < MAX_PAGES; page += 1) {
      setStatus(`Reading order history — page ${page + 1}…`);
      const pageOrders = parseOrderPage(doc, pageUrl);
      orders.push(...pageOrders);
      const dated = pageOrders.map((order) => Date.parse(order.orderDate)).filter(Number.isFinite);
      if (dated.length && dated.every((value) => value < cutoff)) break;
      const next = nextPageUrl(doc, pageUrl);
      if (!next) break;
      doc = await fetchDocument(next);
      pageUrl = next;
    }

    const recent = orders.filter((order) => {
      const date = Date.parse(order.orderDate);
      return Number.isFinite(date) && date >= cutoff;
    });

    let completed = 0;
    for (let i = 0; i < recent.length; i += 4) {
      const batch = recent.slice(i, i + 4);
      await Promise.all(batch.map(async (order) => {
        if (!order.detailUrl || order.items.every((item) => item.originalPrice != null)) return;
        try {
          const detail = await fetchDocument(order.detailUrl);
          order.items = parseDetailPage(detail, order);
        } catch { /* the visible order card may still have enough data */ }
      }));
      completed += batch.length;
      setStatus(`Reading purchase prices — ${completed} of ${recent.length} orders…`);
    }

    const flattened = recent.flatMap((order) => order.items.map((item) => ({
      ...item,
      orderId: order.orderId,
      orderDate: order.orderDate,
      detailUrl: order.detailUrl,
    })));
    return [...new Map(flattened.map((item) => [
      `${item.orderId || item.orderDate}:${item.asin}`, item,
    ])).values()].slice(0, MAX_ITEMS);
  }

  function panel() {
    document.getElementById('bh-order-scan')?.remove();
    const root = document.createElement('section');
    root.id = 'bh-order-scan';
    root.innerHTML = `
      <div class="bh-os-kicker">Better Half</div>
      <h2>30-day Amazon price check</h2>
      <p class="bh-os-status">Starting…</p>
      <div class="bh-os-results"></div>
      <p class="bh-os-note">Amazon does not guarantee post-purchase price adjustments. Better Half prepares a request for you to review; it never submits one automatically.</p>
    `;
    const mount = document.querySelector('#yourOrders, #ordersContainer, main, #a-page') || document.body;
    mount.prepend(root);
    root.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return root;
  }

  function requestText(item) {
    const purchased = item.orderDate
      ? new Date(item.orderDate).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
      : 'within the last 30 days';
    return `Hi, I purchased “${item.title}” in order ${item.orderId || '(order number)'} on ${purchased} for ${money(item.originalPrice)}. The current Amazon price is ${money(item.currentPrice)}, a ${money(item.drop)} difference. Would you please review whether a courtesy refund or credit is available? I understand price adjustments are not guaranteed.`;
  }

  function renderResults(root, scan, totalItems) {
    const status = root.querySelector('.bh-os-status');
    const results = root.querySelector('.bh-os-results');
    const drops = (scan.results || []).filter((item) => item.drop > 0);
    status.textContent = drops.length
      ? `${drops.length} price drop${drops.length === 1 ? '' : 's'} found · ${money(scan.potentialTotal)} potential difference`
      : `Checked ${scan.checked || 0} of ${totalItems} purchases — no lower prices found.`;

    if (!drops.length) return;
    for (const item of drops) {
      const row = document.createElement('article');
      row.className = 'bh-os-row';
      const title = document.createElement('a');
      title.href = item.currentUrl;
      title.target = '_blank';
      title.rel = 'noopener';
      title.textContent = item.title;
      const prices = document.createElement('div');
      prices.className = 'bh-os-prices';
      prices.textContent = `Paid ${money(item.originalPrice)} · now ${money(item.currentPrice)} · down ${money(item.drop)}`;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Copy request & open Amazon support';
      button.addEventListener('click', async () => {
        await navigator.clipboard.writeText(requestText(item));
        window.open('https://www.amazon.com/hz/contact-us', '_blank', 'noopener');
        button.textContent = 'Request copied';
      });
      row.append(title, prices, button);
      results.appendChild(row);
    }
  }

  async function run() {
    const root = panel();
    const setStatus = (text) => { root.querySelector('.bh-os-status').textContent = text; };
    try {
      for (let i = 0; i < 20 && !orderCards(document).length; i += 1) {
        if (document.querySelector('#ap_email, input[name="email"]')) {
          setStatus('Sign in to Amazon, then return to this page and run the check again.');
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const items = await collectRecentItems(setStatus);
      if (!items.length) {
        setStatus('No eligible purchases were found in the last 30 days.');
        return;
      }
      setStatus(`Checking today’s prices for ${items.length} purchase${items.length === 1 ? '' : 's'}…`);
      const scan = await chrome.runtime.sendMessage({ type: 'CHECK_AMAZON_PURCHASES', items });
      if (!scan || scan.error) throw new Error(scan?.error || 'The background checker did not respond.');
      renderResults(root, scan, items.length);
    } catch (error) {
      setStatus(`Could not finish the check: ${error?.message || error}`);
    }
  }

  run();
})();
