# Better Half — handoff

**Version 0.3.8 · 87 tests passing · Chrome MV3 · loads unpacked**

A Chrome extension that (1) proves coupon codes on your real cart before showing them, and
(2) compares Amazon prices against Target, Walmart and Home Depot including shipping. No
login, no accounts, no affiliate links, no server. Everything runs locally.

Read [README.md](README.md) for the *design rationale* — why each rule exists. This file is the
*state of play*: what's proven, what isn't, what to do next, and how to debug it.

---

## Start here

```bash
npm test                  # 87 unit tests, no network
npm run bump              # 0.3.8 -> 0.3.9, keeps manifest+package in lockstep
npm run bump -- minor "what changed"     # also writes CHANGELOG.md
```

Load/reload: `chrome://extensions` → Developer mode → **Load unpacked** → this folder.
After any change, reload there and confirm the popup header shows the new version. The
popup reads `chrome.runtime.getManifest()`, so it cannot disagree with what Chrome loaded.

**Bump the version on every change.** It's the only reliable way to know whether a reload
actually took — a surprising amount of debugging time was lost to testing stale builds.

---

## Status: what is actually proven

Be careful here. "Works" below means *verified against a live page or API*, not
*looks right in code*.

| Component | State | Evidence |
|---|---|---|
| Match gate (`src/match/`) | **Solid** | 70 tests over titles captured from real pages |
| Amazon extraction | **Solid** | Verified on 5 live listings incl. out-of-stock, suppressed buy box, electronics, tools |
| Target adapter | **Works** | Live search + PDP, no bot challenge, ~1.1s |
| Home Depot adapter | **Works** | Live search, no bot challenge, model-number lookup resolves exactly |
| Walmart adapter | **Partly proven** | Page loads with no bot challenge; DOM price parse fixed against one live search page |
| Coupon verifier | **Proven by hand, NOT in-extension** | `WELCOME20` applied/measured/reverted on Kyte Baby's live checkout — but via console JS, never through the extension itself |
| Coupon aggregator sources | **Runs, yield unproven** | `harvest()` confirmed to load CouponFollow in a real tab (v0.3.5 in the wild). Whether the `[data-code]` scrape returns usable codes there is still unverified |
| Coupon *triggering* | **Was badly wrong, now gated** | v0.3.5 fired on any input matching `/promo\|coupon\|…/`, including aggregators' own search boxes — a self-sustaining tab loop. Fixed in v0.3.6, see `test/coupon-gate.test.js` |
| Shared/synced code ledger | **Not built** | Deliberately deferred; schema is share-ready |

### The honest summary

The **comparison** path is in good shape. The **coupon** path first ran for real in v0.3.5,
on a SaaS billing page with a promo field — and immediately exposed the thing unit tests
could not: *triggering* had never been designed, only detection. "There is an input that
matches `/promo|coupon/`" was treated as "the user is checking out", and since the
aggregator pages we open to look up codes are themselves full of coupon-shaped inputs, one
legitimate trigger became an unbounded loop of tabs opening and closing.

The lesson worth keeping: every part being individually verified said nothing about whether
the parts should run *at all* on a given page. v0.3.6 adds that gate. The coupon path still
has not been proven to *succeed* on a real cart — only to no longer fire when it shouldn't.

---

## Open issues, roughly ranked

1. **Variant mismatch on multi-variant products.** The OutdoorMaster helmet is $23.48 (L),
   $24.64 (M), $26.90 (S). Nothing currently ensures the matched Walmart variant is the
   same size as the Amazon one, so a reported saving may be comparing L against S. Colour
   and fitted size are stripped before matching *by design* (see `stripVariantAttrs` — it's
   what let the Oura Ring match at all), but when variants differ in **price** that
   stripping becomes a correctness bug. Likely fix: keep stripping for *matching*, but
   when a variant note exists AND prices differ across variants, either pick the matching
   variant or downgrade the claim.

2. **Coupon flow still unproven on a real checkout.** It has now been run in a real browser,
   which is how the v0.3.6 tab loop was found (below) — but that was a *false positive*, not
   a real cart. Still to do: a real Shopify checkout, expect the banner, then either an
   applied code or "no working code found". Verify the cart is untouched when nothing wins.

3. **Harvest tabs land in the user's own window on macOS.** *Visible symptom fixed and
   confirmed live in v0.3.7 — no tabs blinking, nothing on the desktop.* `getWorkerWindow()`
   creates a plain unfocused window and hides it *afterwards* (`windows.update` with
   `state: 'minimized'`, falling back to `left: -2000, top: -2000`), because macOS rejects
   `minimized` at *create* time but honours it on a window that already exists.

   **What that first live run also exposed:** hiding the window made both tab-based
   retailers time out. `windows.update({state:'minimized'})` does not reject on macOS — it
   *hangs* — and v0.3.7 awaited it unbounded, so Walmart and Home Depot blew past the 22s
   per-adapter timeout without their own 15s/20s harvest timeouts ever firing. That gap is
   the diagnostic: when the outer timeout fires and the inner ones don't, the stall is before
   the timed section. v0.3.8 bounds every await in there. Still to confirm live: that Walmart
   and Home Depot now return results rather than `timed out`.

4. **Harvest tabs leak when the service worker is killed.** *Fixed in v0.3.7, unit-tested,
   not yet observed live.* `harvest()` closes its tab in a `finally`, but MV3 terminates the
   worker after ~30s idle and the `finally` dies with it. The worker window id is now kept in
   `chrome.storage.session` and swept at module evaluation, i.e. once per worker startup.

   **`storage.session`, not `.local`, is load-bearing.** Window ids are only unique within a
   browser session; after a restart the counter resets and a remembered id can name one of
   the user's real windows. `session` survives the worker being killed (what we need) and is
   wiped when the browser closes (where acting on the id would close someone's work). Do not
   "improve" this to `.local` for durability.

   To reproduce the original leak: start a harvest, then hit *stop* on the service worker in
   `chrome://extensions` mid-flight. The tab should survive; reloading the page (which wakes
   the worker) should then sweep it.

5. **Walmart in *your* Chrome.** It loaded clean here, but this preview browser is Electron
   with a non-standard UA. Use the popup's **Test retailer connections** button — that is
   the ground truth, and it takes two seconds.

6. **Amazon SPA navigation.** The content script runs at `document_idle`. Navigating
   between products via search results sometimes won't re-fire the card; ⌘R always works.
   Fix would be a URL-change observer.

7. **Home Depot titles are slug-derived.** Pod anchors have empty `innerText`, so titles
   come from the URL slug (`Milwaukee-SHOCKWAVE-...` → `Milwaukee SHOCKWAVE ...`). Works,
   but it's crude and will read oddly if surfaced more prominently.

8. **`examined` counts candidates considered, not matches rejected.** Fine for the card's
   "N candidates considered" line, but don't read more into it.

---

## Debugging playbook

**Always start with the popup's "Test retailer connections" button.** It runs a known-good
product through each adapter and reports per-retailer status, reason and timing. It
isolates the retailers from the Amazon page, the matcher and the card.

**Service worker console:** `chrome://extensions` → Better Half → click *service worker*.
All diagnostics log as `[better-half] …`.

**Test the service worker in Node.** Non-obvious and very useful — the SW can be imported
with a shimmed `chrome` global, which catches import-time errors and lets you invoke the
message handlers directly:

```js
globalThis.chrome = {
  runtime: { onMessage: { addListener: (fn) => { listener = fn; } } },
  // Omitting storage.session is fine — the harvester degrades to in-memory.
  // Add it (get/set/remove) if you want to exercise the stale-window sweep;
  // `test/worker-window.test.js` has a working one.
  storage: { local: { get: async () => ({}), set: async () => {} } },
  tabs: { create: async () => { throw new Error('no tabs in node'); }, /* … */ },
  windows: { create: async () => { throw new Error('no windows'); }, /* … */ },
  scripting: { executeScript: async () => [{ result: null }] },
};
await import('./src/background/service-worker.js');
// then: listener({ type: 'DIAGNOSE' }, {}, console.log)
```

**Beware: Node lies about the things that matter most.** Different TLS fingerprint, no
tabs, no windows. `node scripts/live-check.js` will start returning `403` from Target after
a few runs — that is Node being blocked, not the extension. Verified directly: same URL,
same IP, same second returns `200` in a browser and `403` in Node. **When a retailer
result matters, check it in a real browser.**

---

## Traps that will bite you

Full reasoning is in `README.md`; these are the ones most likely to be "simplified" back
into bugs.

- **Never read an Amazon price outside the buybox.** On an out-of-stock or
  buy-box-suppressed page, every `.a-price` belongs to a sponsored card. This produced
  `$190.57` for an unbuyable item, and `$29.09` for one Amazon flags as overpriced.
- **Check availability *before* price.** Related to the above.
- **`fl oz` must precede `oz` in the unit regex.** Otherwise "32 fl oz" silently parses as
  32 ounces of powder and invents a 4.5× saving.
- **Walmart's `__NEXT_DATA__` has no prices.** Every price field is empty/`0` on arrival
  and hydrated client-side. Reading `price` there yields `0`, which then rendered as bare
  `$6.99` shipping on the card. Prices come from the DOM.
- **A price of `0` is not a price.** Filter on `> 0`, never `!= null`.
- **A price *range* is not a price.** Target quotes `"$399.00 - $499.00"`; taking the first
  number invents a $100 saving. Ranges surface as `PRICE_VARIES`, never a saving claim.
- **Never abort coupons just because card fields exist.** Shopify's one-page checkout puts
  the discount box and the card fields together; that rule would disable the feature on
  nearly every Shopify store. Only write to the discount input, never click pay.
- **Don't exhaustively test coupon codes.** Single-use codes are consumed by testing. Stop
  at the first good-enough win.
- **At module scope, reach for `globalThis.chrome`, never bare `chrome`.** Optional chaining
  only guards a *declared* identifier against being null — `chrome?.storage` still throws a
  ReferenceError where `chrome` was never declared, which is every plain Node import of the
  module. Because that throw happens during module evaluation it fails the whole service
  worker registration, and it takes any importer's tests down with it: writing it the wrong
  way in `tab-harvester.js` turned three unrelated test files red at once.
- **Everything needs a timeout, and a `try/catch` is not one.** An unbounded `await` anywhere
  becomes a permanent spinner in the user's face — that exact bug has now shipped twice. The
  second time, v0.3.7 wrapped `windows.update({state:'minimized'})` in a `try/catch` and
  assumed that covered it; on macOS the call never settles, so the catch never runs and the
  harvest simply stopped. A catch handles rejection. Only a timeout handles silence.
- **The card must never vanish.** Silently removing it is indistinguishable from a crash.

---

## Architecture

```
manifest.json          MV3; icons/ generated from assets/*.svg
src/
  background/
    service-worker.js  orchestration, message router, DIAGNOSE self-test
    tab-harvester.js   hidden-tab primitive: timeouts, concurrency cap, window cleanup
    coupon-sources.js  aggregator scraping via harvest()
  adapters/            target · walmart · homedepot  (uniform lookup/shippingFor interface)
  content/
    amazon-pdp.js      extraction + card rendering
    coupon-runner.js   checkout detection + orchestration
  coupon/              site-profiles · verifier (apply → measure → revert)
  match/               normalize · keywords · confidence   ← the tested core
  ledger/store.js      chrome.storage, share-ready schema
  ui/                  card.css, popup/
test/                  match · search · unsized · hardware · coupon-gate · worker-window
scripts/               bump.js · live-check.js
```

**Adding a retailer:** implement `RETAILER`, `lookup(source, opts)`, `shippingFor(subtotal,
opts, scraped)` and add it to `ADAPTERS` in the service worker. Prefer a JSON API
(`fetchJson`) over `harvest()` — Target answers in ~1s, tab-based adapters take 5–20s.
**Always prefer scraped shipping over the threshold table**: the table was wrong once, adding
$8.99 to a $44.99 item whose page plainly read "FREE delivery", which flipped the verdict to
the wrong retailer.

---

## Deliberately not done

- **Shared coupon database.** Wants a server; the ledger schema (`{domain, code, outcome,
  discountPct, minSpendObserved, lastTestedAt}`) carries no identity or browsing data, so
  adding opt-in sync later is a transport change with no migration.
- **eBay / Costco adapters.** eBay skews used/third-party, which muddies matching.
- **Tax.** Compared pre-tax, and the card says so.
- **Chrome Web Store listing.** Unpacked, personal use.
- **Partial model-number matching.** `UBGWL` appears in both a Deflecto and an Everbilt
  part number, and `48-32-4013` shares a prefix with `48-32-4024`. Exact match only.

---

## Product note worth remembering

Across every real product tested, **cross-retailer comparison found roughly $0**, while
**Amazon's own on-page coupons found ~$61** (30% Subscribe & Save on Similac, 40% on Butt
Paste). The wins that did appear were an out-of-stock Amazon item ($54.99 at Target), a
genuine $100 gap on the Oura Ring, and $6.49 on the Milwaukee set.

Small sample, but if you're deciding where to spend effort: surfacing Amazon's own offers
is cheap and has paid better than the comparison engine so far.
