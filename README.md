# Better Half

> Picking this up after a break? Start with **[HANDOFF.md](HANDOFF.md)** — current state,
> what is proven vs unproven, open issues, and the debugging playbook.

A Chrome extension that does three things, with **no Better Half login, no accounts, and no affiliate links**:

1. **Coupon codes that actually work.** Never shows a code that hasn't just been proven on your real cart.
2. **True total-cost comparison.** While you're on Amazon, checks Target, Walmart and Home Depot including shipping. Costco.com is an opt-in retailer.
3. **30-day Amazon purchase check.** On demand, reads recent Amazon orders, checks today's price for the exact ASIN, and prepares a courtesy-adjustment request when the price fell.

Everything runs locally. No server, nothing leaves your machine.

## Install

```bash
open -a "Google Chrome" --args --load-extension="$PWD"
```

Or: Chrome → Extensions → enable Developer mode → **Load unpacked** → select this folder.

## Versioning

Bump on every change, so the version in `chrome://extensions` and in the popup header
tells you exactly which build is loaded:

```bash
npm run bump
```

`0.2.1 → 0.2.2`. It keeps `manifest.json` and `package.json` in lockstep — a version that
moves in only one is worse than not bumping, because you'd trust a number that doesn't
match what Chrome loaded.

```bash
npm run bump -- minor "added Home Depot adapter"
```

Accepts `patch` (default), `minor`, or `major`, and any trailing text is recorded in
`CHANGELOG.md`. Use `npm run release` to run the tests first and only bump if they pass.

The popup reads its version via `chrome.runtime.getManifest()`, so it can never disagree
with the running build — check there to confirm a reload actually took.

## Run the tests

```bash
npm test
```

Check the adapters against live retailer APIs (needs network):

```bash
node scripts/live-check.js
```

⚠️ This script will start returning `HTTP 403` after a handful of runs. That is a
limitation of **Node**, not of the extension: Node's TLS fingerprint isn't Chrome's, and
Target blocks it. Verified directly — the same URL, same IP, same moment, returns `200` in
a browser and `403` in Node. The extension runs inside Chrome and is unaffected. If the
script is blocked, test in the loaded extension instead.

## How it works

**Comparison.** A content script reads the Amazon page — availability first, then a
buybox-scoped price, plus UPC and pack size from the detail table. The service worker
queries retailer adapters concurrently and runs every candidate through a match gate.

**Amazon purchases.** The popup button opens Amazon's order history and reads up to 30
items purchased in the last 30 days. Current prices are checked against the exact ASIN.
Order numbers and purchase details stay in memory for the scan and are not persisted.
Amazon does not guarantee post-purchase adjustments, so Better Half copies a request and
opens customer service; it never promises or automatically submits a refund request.

**Coupons.** At a checkout, the user opens Better Half and chooses **Try coupons on this
checkout**. That explicit action grants temporary access to only the current tab; the
extension does not request access to every site the user visits. The runner collects
candidate codes (previously proven ones first, then codes the merchant advertises, then a
few cheap generics), applies each to the real cart, reads the resulting total, and keeps
only what worked. Failed codes are never shown; the cart is restored if nothing wins.

## Design notes

These are the non-obvious decisions. Each came from testing against real pages, and each
one breaks if "simplified".

**Availability is checked before price.** On an out-of-stock Amazon listing there is no
buybox price, but the page is still full of prices from the "Similar items" rail. A bare
`.a-price` query returns one of those — on a real page that produced `$190.57` for an item
Amazon could not sell at all. See `src/content/amazon-pdp.js`.

**Detail rows are parsed, not page text.** Amazon writes labels as `ASIN ‏ : ‎ B09F5FHFPC`
with embedded bidi control characters, so a regex over `innerText` silently misses UPC.

**Weight, volume and count never mix.** Ready-to-feed formula at `$0.40/fl oz` looks 4.5×
cheaper than powder at `$1.82/oz`. It isn't cheaper, it's a different product. In
`normalize.js` the regex alternation lists `fl oz` before `oz` — reverse them and
"32 fl oz" silently parses as 32 ounces of powder.

**Different pack sizes compare by unit price only.** Retailers deliberately stock
mismatched sizes to defeat comparison: Amazon sells 34.9oz×3, Target sells a 30.2oz tub,
and the UPCs genuinely differ. Comparing totals there would invent a $135 "saving".
`TIER.EQUIVALENT_UNIT` exists so these produce a real answer ($1.82/oz both sides — no
saving) without ever permitting a total comparison.

**"Out of stock here, available there" is a first-class result.** Often the most useful
thing the extension can say, and a comparison UI that only knows how to render a price
delta gets it wrong.

**We do not abort just because card fields exist.** Shopify's one-page checkout renders
the discount box and the credit-card fields on the same page, so that rule would disable
coupons on nearly every Shopify store. Instead: only ever write to the discount input,
never click the pay button (`resolveSubmit` refuses any button labelled like a purchase),
and abort if payment details are already filled in.

**Success is detected by the total changing, not by a label.** Shopify obfuscates its
applied-discount chip; no `[class*="discount"]` selector finds it.

**We stop at the first good-enough code.** Aggregators list single-use codes that are
consumed by being tested, so applying a winner and stripping it to hunt for a marginally
better one can lose it outright. Testing also costs ~4s per code, serially — there's only
one cart — so the candidate list is capped at 6 and ranked.

**Referral codes rank last.** SimplyCodes lists Kyte Baby codes like `LL-89RBSWZD` and
`RAF-RAQIJLLE`. Those are per-account referral links: least likely to work, and testing
one burns it. Public codes with a stated discount go first.

**Coupon sources are read from `[data-code]`, not page text.** Aggregator pages carry a
mega-nav of other retailers; a text scan pulls in their codes plus the aggregator's own
promos (`SIMPLYCODESD`, `TOPGUMG`).

**The merchant is resolved, not read off the hostname.** Shop Pay runs checkout on
`shop.app` — a domain shared by every Shopify store. Keying the ledger on
`location.hostname` would file Kyte Baby's codes under `shop.app` and then offer them to
unrelated shops. `resolveMerchant()` extracts the stable shop id from the URL instead.

**Search keywords keep line numbers and drop sizes.** The naive builder stripped every
bare number, losing the `360` in "Similac 360 Total Care" — the single most identifying
token. A number followed by a unit is a size; a bare one is part of the name. It also
turned `Boudreaux's` into `boudreaux s`, leaking a junk token into the query.

**The card stays out of the way unless there's something to act on.** A win shows the full
linked comparison table. No win shows one line — "This is the best price" — and no match
at all shows nothing.

**A price range is not a price.** Target quotes `"$399.00 - $499.00"` for multi-variant
products. Taking the first number yields $399, which against Amazon's $499 invents a $100
saving on a variant the shopper may not want. `parsePriceInfo` flags ranges, `parsePrice`
returns null for them, and they surface as `PRICE_VARIES` — a lead to follow, never a
saving claim.

**Unsized goods are first-class.** Requiring a parseable quantity made every
non-consumable invisible — electronics, apparel, jewellery. When *neither* side has a
size we compare as single units but demand a stronger title match. When only one side has
one, we reject: we can't claim they're the same.

**Generic unsized goods require the source brand.** Titles such as "Adjustable Kids
Helmet with Knee Pads" describe a category, not a unique product. When Amazon supplies a
brand and there is no exact barcode or model, that brand must also appear in the candidate
listing. This prevents retailer search reordering from comparing a different helmet on
each run.

**Variant attributes ≠ product-line discriminators.** Colour and fitted size don't change
what the product is — an Oura Ring in Silver size 10 and Deep Rose size 8 are the same
product at the same price, so blocking on "silver" loses a real $100 saving. They're
stripped before matching and *disclosed* in the card. `Sensitive` vs `Gentle Comfort` is
the opposite: a genuinely different product, and it still blocks.

**Search strips colours and superlatives, keeps model numbers.** Querying "oura ring deep
rose world smallest" hunts a finish the other retailer may not stock. And the single-digit
guard that removed the possessive `s` was also eating the `5` in "Oura Ring 5".

**Model number is a first-class identifier.** For tools and hardware the MPN beats UPC —
third-party listings drop the real barcode but keep the part number. Searching Home Depot
for `48-32-4013` returns the exact product, no matching required.

**A UPC field can hold several codes.** Listing B001A4CWHO reports four at once
(`786830337782 795871624188 …`), one per variant. Stripping non-digits welds them into a
48-digit number that matches nothing; `parseBarcodes` splits and matches on any.

**Brand mismatches are disclosed, not hidden.** Listing B0DK6HZ93H carries model
`48-32-4013` under brand "LRYXYY" with a title reading "…for Milwaukee", at $51.48. Home
Depot sells the genuine Milwaukee for $44.99. That comparison is worth making — the
shopper is probably better off with the real one — but the card says so explicitly rather
than implying they're the same product.

**Amazon's own price warnings are surfaced.** On B001A4CWHO Amazon renders "High price",
states "Typical price: $19.99", and *suppresses the buy box*. When that happens every
`.a-price` on the page belongs to a sponsored card — a naive extractor reports $29.09 for
a product Amazon isn't really selling. We read the warning instead and lead with it: no
other retailer needed.

**Accessories are the sharpest trap.** Target's Oura results include a $10 "Oura Ring 5
Sizing Kit" — same brand, same model number. A loose matcher reports a $489 saving on a
plastic sizing gauge. `test/unsized.test.js` runs the real eight-result list and asserts
only the true equivalent matches.

## Status

| Component | State |
|---|---|
| Amazon extraction | Validated on 3 live products, incl. an out-of-stock case |
| Target adapter | Validated live (search + PDP, no bot challenge) |
| Costco adapter | Opt-in; browser-harvested search/PDP, live verification still required |
| Match gate | 27 unit tests over real captured titles |
| Coupon verifier | Apply/measure/revert validated on a live Shopify checkout |
| **Walmart adapter** | **Unproven — see below** |

Walmart runs Akamai plus PerimeterX. Plain scrapers fail at TLS fingerprinting, which an
extension inherently passes, and the adapter routes through a harvested tab so the
anti-bot JavaScript actually executes. But this has not been confirmed in a real unpacked
extension yet. If it stays blocked, comparison degrades to Target-only, which works today.

## Layout

```
src/
  background/   service worker, hidden-tab harvester, coupon sources
  adapters/     target · walmart · homedepot · costco
  content/      amazon-pdp, coupon-runner
  coupon/       site-profiles, verifier
  match/        normalize, keywords, confidence
  ledger/       local store (schema is share-ready)
  ui/           card styles, popup
test/           match · search · unsized · hardware
scripts/        bump.js · live-check.js
```

The ledger records only `{domain, code, outcome, discountPct, minSpendObserved,
lastTestedAt}` — no identity, cart contents, or browsing history — so an opt-in shared
database can be added later as a pure transport change.

## Scope and caveats

**This is a personal-use project, published as-is.** No warranty, no support.

**Automated retailer queries sit against most retailers' terms of service**, even at the
one-request-per-page-view volume this does. It's the same category of tool as any
price-comparison extension, but worth knowing before you run it.

**Target's `redsky` API key in `src/adapters/target.js` is not a secret of mine** — it is
publicly embedded in Target's own web client and is visible to anyone who opens their site.
No credentials, accounts, or personal data are used anywhere in this project.

**Nothing leaves your machine.** No server, no analytics, no affiliate links, no accounts.
Retailer lookups go directly from your browser to each enabled retailer, exactly as if
you'd searched the site yourself.

**Coupon verification modifies a live cart** — it applies discount codes, reads the
resulting total, and reverts. It never clicks a pay/submit button and aborts if payment
details are already entered, but you should understand that before enabling it.

**Retailer adapters break** when sites change their markup. `npm test` won't catch that —
use the popup's **Test retailer connections** button.
