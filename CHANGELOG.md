# Changelog

## 0.3.12 — 2026-08-13

- Replace broad site access with user-invoked activeTab checkout access

## 0.3.11 — 2026-08-13

- Regenerate the 128px icon as a valid PNG for Chrome Web Store processing

## 0.3.10 — 2026-08-13

- Stop opening an about:blank placeholder during retailer checks

## 0.3.9 — 2026-08-07

- Give each retailer one shared deadline, so two-phase searches cannot stack past the budget

## 0.3.8 — 2026-08-07

- Bound every await in getWorkerWindow — a hanging minimise was stalling Walmart and Home Depot

## 0.3.7 — 2026-08-07

- Hide the harvest window reliably on macOS, and sweep windows stranded when MV3 kills the worker

## 0.3.6 — 2026-07-27

- fix: coupon flow no longer fires outside checkout, and no longer recurses into its own harvest tabs

## 0.3.5 — 2026-07-26

- added HANDOFF.md — state of play, proven vs unproven, open issues, debugging playbook

## 0.3.4 — 2026-07-26

- Walmart price read from DOM (its JSON ships price 0, which rendered as bare $6.99 shipping); one row per retailer; worker window now closes

## 0.3.3 — 2026-07-26

- added 'Test retailer connections' diagnostic to the popup — names each retailer, its result or failure reason, and timing

## 0.3.2 — 2026-07-26

- surface why each retailer failed; Target backs off only after repeated 403s (was a 10-min lockout on one); explicit redsky host permission

## 0.3.1 — 2026-07-26

- card never disappears; states which retailers were checked and how many candidates were weighed

## 0.3.0 — 2026-07-26

- renamed to Better Half with new logo and icons; fixed infinite 'Checking other retailers' spinner with timeouts at every layer

## 0.2.1 — 2026-07-26

- scraped shipping overrides threshold table; Walmart no longer filters out unsized goods; version shown in popup

## 0.2.0 — 2026-07-26

- Home Depot adapter; model-number matching; brand-mismatch disclosure; Amazon high-price warnings; multi-UPC and price-range fixes

