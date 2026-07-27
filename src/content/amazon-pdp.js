/* global chrome */
/**
 * Amazon product page extraction.
 *
 * Plain content script (no ES modules) so it can run in the isolated world.
 *
 * Two rules here were learned the hard way on real pages, and a naive
 * implementation gets both wrong:
 *
 *   1. AVAILABILITY BEFORE PRICE. On an out-of-stock listing there is no
 *      buybox price, but the page is still full of prices — the "Similar items
 *      that may deliver to you quickly" rail. A bare `.a-price` query returns
 *      one of those. On a real validation run that produced "$190.57" for an
 *      item Amazon could not sell at all.
 *
 *   2. STRIP BIDI CHARACTERS. Amazon writes detail labels as
 *      "ASIN ‏ : ‎ B09F5FHFPC" with embedded direction marks. A regex over
 *      innerText silently misses UPC unless they're removed first.
 */
(() => {
  'use strict';

  const BIDI = /[‎‏؜‪-‮]/g;
  const clean = (s) => String(s || '').replace(BIDI, '').replace(/\s+/g, ' ').trim();

  /**
   * Amazon uses a different detail layout per category. The grocery selectors
   * below return NOTHING on an electronics page — verified on the Oura Ring
   * listing, where every one of them missed and we got no UPC, brand or model.
   * So we cast a wide net and fall back to any spec-shaped table.
   */
  function detailRows() {
    const rows = {};
    const add = (label, value) => {
      const k = clean(label).replace(/\s*:$/, '');
      const v = clean(value);
      if (k && v && k.length < 60 && v.length < 120 && !(k in rows)) rows[k] = v;
    };

    // Two-cell spec tables (th/td or td/td) across every known container.
    document.querySelectorAll([
      '#productDetails_techSpec_section_1 tr',
      '#productDetails_techSpec_section_2 tr',
      '#productDetails_detailBullets_sections1 tr',
      '#productDetails_db_sections tr',
      '#technicalSpecifications_section_1 tr',
      '#prodDetails tr',
      '.prodDetTable tr',
      '#poExpander tr',
      '.a-normal.a-spacing-micro tr',
    ].join(', ')).forEach((r) => {
      const cells = r.querySelectorAll('th, td');
      if (cells.length >= 2) add(cells[0].innerText, cells[1].innerText);
    });

    // The "Product information" bullet style: "Label ‏ : ‎ Value".
    document.querySelectorAll(
      '#detailBullets_feature_div li, #detailBulletsWrapper_feature_div li',
    ).forEach((li) => {
      const t = clean(li.innerText);
      if (!t || t.length > 130) return;
      const m = t.match(/^(.+?)\s*:\s*(\S.*)$/);
      if (m) add(m[1], m[2]);
    });

    // The newer key/value grid Amazon uses on electronics and apparel.
    document.querySelectorAll('.po-attribute, .a-fixed-left-grid.product-facts-detail').forEach((el) => {
      const k = el.querySelector('.a-span3, .a-color-secondary, .product-facts-title');
      const v = el.querySelector('.a-span9, .po-break-word, .product-facts-detail-value');
      if (k && v) add(k.innerText, v.innerText);
    });

    return rows;
  }

  /**
   * Pull a model-shaped token out of a title, for listings that never put the
   * MPN in the detail table. Two shapes are worth trusting:
   *   hyphenated part numbers  "48-32-4013"
   *   alphanumeric model codes "8440P", "DCD771C2"
   * Anything shorter is too generic to be an identifier.
   */
  function modelFromTitle(title) {
    const hyphenated = title.match(/\b\d{2,}(?:-\d{2,}){1,3}\b/);
    if (hyphenated) return hyphenated[0];
    const alnum = title.match(/\b(?=[A-Z0-9-]{5,15}\b)(?=[A-Z-]*\d)(?=[0-9-]*[A-Z])[A-Z0-9-]+\b/);
    return alnum ? alnum[0] : null;
  }

  function readAvailability() {
    const raw = clean(document.querySelector('#availability')?.innerText);
    // No availability block at all usually means a normal in-stock page.
    const unavailable = /currently unavailable|out of stock|unavailable/i.test(raw);
    return { text: raw || 'In Stock', inStock: !unavailable };
  }

  /** Buybox-scoped only. Never a bare `.a-price` query — see note above. */
  function readBuyboxPrice() {
    const box = document.querySelector(
      '#corePrice_feature_div, #apex_desktop, #price_inside_buybox, #corePriceDisplay_desktop_feature_div',
    );
    if (!box) return null;
    const off = box.querySelector('.a-offscreen');
    if (!off) return null;
    const m = clean(off.textContent).replace(/,/g, '').match(/(\d+(?:\.\d{1,2})?)/);
    return m ? Number(m[1]) : null;
  }

  /**
   * Amazon's own verdict on its price.
   *
   * On listing B001A4CWHO Amazon renders "High price" in the right column,
   * states "Typical price: $19.99", and SUPPRESSES THE BUY BOX entirely
   * (showing only "See All Buying Options"). That combination is the strongest
   * possible signal not to buy here — and it comes free, from the page itself,
   * with no other retailer needed.
   *
   * Note the trap: with no buy box, every `.a-price` on the page belongs to a
   * sponsored card. Reporting one of those as "the price" would be badly wrong.
   */
  function readPriceSignals() {
    const rightCol = document.querySelector('#rightCol, #buybox, #desktop_buybox');
    const colText = clean(rightCol?.innerText || '');
    const body = document.body.innerText;

    const typical = body.match(/Typical price:\s*\$([\d,]+\.?\d{0,2})/i);
    return {
      typicalPrice: typical ? Number(typical[1].replace(/,/g, '')) : null,
      // Scoped to the buybox column so a review or Q&A mentioning "high price"
      // can't trigger it.
      flaggedHigh: /\bHigh price\b/i.test(colText),
      buyboxSuppressed: /See All Buying Options/i.test(colText) && !readBuyboxPrice(),
    };
  }

  function readOffers() {
    const text = document.body.innerText;
    const offers = [];
    const coupon = text.match(/Coupon:\s*Save\s*(\d+)%([^\n]{0,80})/i);
    if (coupon) {
      offers.push({
        kind: /subscribe\s*&?\s*save/i.test(coupon[2]) ? 'SUBSCRIBE_AND_SAVE' : 'CLIP_COUPON',
        percent: Number(coupon[1]),
        label: clean(coupon[0]),
      });
    }
    const sns = document.querySelector('#snsPrice, #sns-base-price, #subscriptionPrice');
    if (sns) {
      const m = clean(sns.innerText).replace(/,/g, '').match(/(\d+(?:\.\d{1,2})?)/);
      if (m) offers.push({ kind: 'SUBSCRIBE_AND_SAVE_PRICE', price: Number(m[1]), label: 'Subscribe & Save price' });
    }
    return offers;
  }

  function extract() {
    const titleEl = document.getElementById('productTitle');
    if (!titleEl) return null; // not a product page

    const rows = detailRows();
    const availability = readAvailability();

    return {
      retailer: 'amazon',
      retailerName: 'Amazon',
      url: location.href.split('?')[0],
      title: clean(titleEl.innerText),
      asin: rows.ASIN || (location.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/) || [])[1] || null,
      barcode: rows.UPC || rows['Global Trade Identification Number'] || null,
      brand: rows.Brand || rows['Brand Name'] || null,
      // For tools and hardware the manufacturer part number is the strongest
      // identifier available — third-party listings routinely drop the real UPC
      // but keep the MPN.
      model: rows['Item model number'] || rows.Model || rows['Part Number']
        || rows['Manufacturer Part Number'] || rows['Model Name']
        // Not every listing puts the MPN in the detail table. "Alden 8440P Pro
        // Grabit…" carries it only in the title, so fall back to a model-shaped
        // token there: mixed letters+digits, or a hyphenated part number.
        || modelFromTitle(clean(titleEl.innerText)) || null,
      inStock: availability.inStock,
      availabilityText: availability.text,
      // Deliberately null when unavailable — an unbuyable item has no price.
      price: availability.inStock ? readBuyboxPrice() : null,
      structured: {
        unitCount: rows['Unit Count'] || null,
        numberOfItems: rows['Number of Items'] || null,
        eachUnitCount: rows['Each Unit Count'] || null,
        size: rows.Size || null,
      },
      offers: readOffers(),
      priceSignals: readPriceSignals(),
    };
  }

  // ------------------------------------------------------------------ UI --

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function money(n) {
    return n == null ? '—' : `$${Number(n).toFixed(2)}`;
  }

  function mountPoint() {
    return document.querySelector('#corePrice_feature_div, #apex_desktop, #centerCol') || document.body;
  }

  function renderLoading() {
    document.querySelector('.sd-card')?.remove();
    const card = el('div', 'sd-card sd-card--loading');
    card.appendChild(el('div', 'sd-kicker', 'Better Half'));
    card.appendChild(el('div', 'sd-status', 'Checking other retailers…'));
    mountPoint().prepend(card);
    return card;
  }

  /** Retailer name as a link when we know where the product lives. */
  function retailerCell(offer) {
    if (!offer.url) return el('span', 'sd-retailer', offer.retailerName);
    const a = document.createElement('a');
    a.className = 'sd-retailer sd-link';
    a.href = offer.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = offer.retailerName;
    return a;
  }

  /**
   * Amazon's own price warnings, rendered as first-class notes. These are
   * actionable on their own — no other retailer required — and on a suppressed
   * buy box they may be the ONLY reliable price information on the page.
   */
  function priceSignalNotes(product) {
    const s = product.priceSignals || {};
    const out = [];

    if (s.flaggedHigh || s.buyboxSuppressed) {
      const n = el('div', 'sd-offer sd-offer--warn');
      n.textContent = s.buyboxSuppressed
        ? 'Amazon has hidden the buy box on this listing and flags the price as high.'
        : 'Amazon flags this as a high price.';
      out.push(n);
    }
    if (s.typicalPrice != null) {
      const n = el('div', 'sd-offer sd-offer--warn');
      n.textContent = product.price != null && product.price > s.typicalPrice
        ? `Amazon says the typical price is ${money(s.typicalPrice)} — you're looking at ${money(product.price)}.`
        : `Amazon says the typical price is ${money(s.typicalPrice)}.`;
      out.push(n);
    }
    return out;
  }

  function amazonOfferNotes(product) {
    return (product.offers || [])
      .filter((o) => o.percent || o.price)
      .map((o) => {
        const note = el('div', 'sd-offer');
        note.textContent = o.percent
          ? `On this page: save ${o.percent}% with ${o.kind === 'SUBSCRIBE_AND_SAVE' ? 'Subscribe & Save' : 'the clip coupon'}`
          : `${o.label}: ${money(o.price)}`;
        return note;
      });
  }

  function renderResult(result, product) {
    document.querySelector('.sd-card')?.remove();

    const { verdict, offers = [], best, saving, comparedBy } = result || {};
    const isWin = verdict === 'CHEAPER_ELSEWHERE'
      || verdict === 'UNAVAILABLE_HERE_AVAILABLE_THERE'
      || verdict === 'PRICE_VARIES';
    const warnings = priceSignalNotes(product);
    const notes = [...warnings, ...amazonOfferNotes(product)];

    // The card NEVER disappears. An earlier version removed itself when nothing
    // matched, which looked exactly like a crash — it flashed "Checking other
    // retailers…" and then vanished, leaving no way to tell whether it had
    // searched and found nothing or simply broken. Staying quiet is fine;
    // staying silent is not.
    const card = el('div', `sd-card${isWin ? ' sd-card--win' : ' sd-card--quiet'}`);
    card.appendChild(el('div', 'sd-kicker', 'Better Half'));

    const headline = el('div', 'sd-headline');
    // Amazon's own warning outranks everything: if it says the price is high
    // and hides the buy box, that is the headline, not a footnote.
    if (!isWin && warnings.length) {
      headline.textContent = product.priceSignals.buyboxSuppressed
        ? 'Amazon is not selling this at a normal price'
        : 'Amazon flags this price as high';
      card.classList.remove('sd-card--quiet');
    } else if (verdict === 'CHEAPER_ELSEWHERE') {
      headline.textContent = comparedBy === 'unit'
        ? `Cheaper per ${best.unitLabel || 'unit'} at ${best.retailerName}`
        : `Save ${money(saving)} at ${best.retailerName}`;
    } else if (verdict === 'UNAVAILABLE_HERE_AVAILABLE_THERE') {
      headline.textContent = `Unavailable on Amazon — ${best.retailerName} has it for ${money(best.total)}`;
    } else if (verdict === 'PRICE_VARIES') {
      headline.textContent =
        `${best.retailerName} lists ${money(best.priceRange[0])}–${money(best.priceRange[1])}`;
    } else if (verdict === 'NO_SAVING') {
      headline.textContent = 'This is the best price';
    } else if (result.checked && result.checked.length) {
      // We looked and found nothing comparable. Say which retailers were
      // searched — "no match" from a tool that checked three stores means
      // something quite different from one that failed to run.
      headline.textContent = 'No match found elsewhere';
    } else {
      headline.textContent = 'Could not reach other retailers';
    }
    card.appendChild(headline);

    // Amazon's own offers routinely beat any cross-retailer gap, so they show
    // even when there's no win to report.
    notes.forEach((n) => card.appendChild(n));

    if (isWin) {
      // The full table only earns its space when there is something to act on.
      const table = el('div', 'sd-rows');
      const src = {
        retailerName: 'Amazon',
        total: product.price,
        unitPrice: result.sourceUnitPrice,
        unitLabel: result.sourceUnitLabel,
        quantityLabel: result.sourceQuantityLabel,
        inStock: product.inStock,
        url: null,
      };
      [src, ...offers].forEach((o) => {
        const row = el('div', 'sd-row');
        row.appendChild(retailerCell(o));
        // Spell out pack size, or a differing colour/fitted size, so the
        // comparison is self-evidently like-for-like — or visibly not.
        row.appendChild(el('span', 'sd-size', o.quantityLabel || o.variantNote || ''));
        const priceText = o.inStock === false ? 'Unavailable'
          : o.priceRange ? `${money(o.priceRange[0])}–${money(o.priceRange[1])}`
            : money(o.total);
        row.appendChild(el('span', 'sd-price', priceText));
        row.appendChild(el('span', 'sd-unit',
          o.unitPrice != null ? `${money(o.unitPrice)}/${o.unitLabel || 'unit'}` : ''));
        table.appendChild(row);
      });
      card.appendChild(table);

      // A brand disagreement is material: the listing you're looking at may be
      // an aftermarket copy of the item the other retailer sells directly.
      const flagged = offers.find((o) => o.brandNote);
      if (flagged) card.appendChild(el('div', 'sd-offer', `Note: ${flagged.brandNote}.`));

      card.appendChild(el('div', 'sd-foot',
        comparedBy === 'unit'
          ? 'Pack sizes differ, so these are compared per unit. Includes shipping, before tax.'
          : comparedBy === 'range'
            ? 'Price varies by variant — the cheapest may not be the one you want. Check before buying.'
            : 'Totals include shipping, before tax.'));
    } else if (verdict === 'NO_SAVING' && best) {
      // One quiet line of evidence, not a table.
      const cmp = el('div', 'sd-foot');
      cmp.appendChild(document.createTextNode('Checked '));
      cmp.appendChild(retailerCell(best));
      cmp.appendChild(document.createTextNode(
        comparedBy === 'unit'
          ? ` — ${money(best.unitPrice)}/${best.unitLabel || 'unit'} vs yours at ${money(result.sourceUnitPrice)}.`
          : ` — ${money(best.total)} with shipping.`));
      card.appendChild(cmp);
    } else {
      // No match. Name the retailers searched and how many candidates were
      // weighed, so "found nothing" is visibly a conclusion rather than a
      // failure to run.
      const who = (result.checked || []).join(', ');
      const n = result.examined || 0;
      if (who) {
        card.appendChild(el('div', 'sd-foot',
          `Checked ${who}${n ? ` — ${n} candidate${n === 1 ? '' : 's'} considered, none close enough to compare` : ' — nothing comparable listed'}.`));
      }

      // Name each failure and why. Without this the card is a dead end for
      // anyone trying to work out whether the extension is broken or the
      // retailer simply blocked us.
      for (const f of result.failed || []) {
        const name = typeof f === 'string' ? f : f.name;
        const reason = typeof f === 'string' ? null : f.reason;
        card.appendChild(el('div', 'sd-foot',
          reason ? `${name}: ${reason}` : `Could not reach ${name}.`));
      }
    }

    mountPoint().prepend(card);
  }

  // --------------------------------------------------------------- start --

  /**
   * The card must always reach a final state.
   *
   * This is the outermost guard: even if the service worker never replies —
   * because it was torn down, threw before responding, or an adapter stalled —
   * the spinner is replaced. A stuck "Checking other retailers…" is the worst
   * failure mode there is, because it looks like it's still working.
   */
  const OVERALL_TIMEOUT_MS = 26000;

  async function run() {
    const product = extract();
    if (!product) return;

    renderLoading();
    try {
      const result = await Promise.race([
        chrome.runtime.sendMessage({ type: 'COMPARE', product }),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('timed out waiting for background')), OVERALL_TIMEOUT_MS,
        )),
      ]);

      if (!result) throw new Error('no response from background');
      if (result.error) throw new Error(result.error);
      renderResult(result, product);
    } catch (e) {
      console.debug('[better-half]', e);
      // Amazon's own price warnings don't need any retailer lookup, so they're
      // still worth showing when the comparison itself failed.
      renderResult({ verdict: 'NO_VERIFIED_MATCH', offers: [] }, product);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
})();
