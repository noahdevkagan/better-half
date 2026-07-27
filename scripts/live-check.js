/**
 * End-to-end check against the live Target API.
 *
 * Not part of `npm test` — it needs the network and real retailer responses.
 * Run it when an adapter looks broken:  node scripts/live-check.js
 *
 * Source products are real captures from Amazon pages.
 */
import { normalizeQuantity, unitPrice } from '../src/match/normalize.js';
import { matchConfidence, buildVerdict, TIER } from '../src/match/confidence.js';
import * as target from '../src/adapters/target.js';

const CASES = [
  {
    name: 'Similac 360 Total Care Sensitive 30.2oz (unavailable on Amazon)',
    title: 'Similac 360 Total Care Sensitive Baby Formula Powder, 5 HMO Prebiotic Blend | Infant formula for babies with lactose sensitivity; immune system, brain development & digestive health support, 30.2 oz tub',
    structured: { size: '30.2 Ounce (Pack of 1)' },
    barcode: '070074681238',
    price: null,
    inStock: false,
  },
  {
    name: 'Boudreaux’s Butt Paste Max Strength 14oz',
    title: 'Boudreaux’s Butt Paste Max Strength Diaper Rash Cream for Baby, Ointment With Zinc Oxide, 14 oz Flip-Top Jar',
    structured: {},
    barcode: '362103001941',
    price: 16.97,
    inStock: true,
  },
  {
    name: 'Similac 360 Total Care Sensitive 34.9oz 3-pack',
    title: 'Similac 360 Total Care Sensitive Baby Formula Powder, 5 HMO Prebiotic Blend | Infant formula for babies with lactose sensitivity; immune system, brain development & digestive health support, 34.9 oz, 3pk',
    structured: { unitCount: '104.7 Ounce', numberOfItems: '3', eachUnitCount: '34.9', size: '34.9 Ounce (Pack of 3)' },
    barcode: '070074681207',
    price: 190.57,
    inStock: true,
  },
];

const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);

for (const c of CASES) {
  const quantity = normalizeQuantity(c.title, c.structured);
  const source = {
    title: c.title, barcode: c.barcode, quantity, inStock: c.inStock,
    total: c.price, unitPrice: unitPrice(c.price, quantity),
  };

  console.log(`\n── ${c.name}`);
  console.log(`   Amazon: ${c.inStock ? money(c.price) : 'Currently unavailable'}` +
    `  ${quantity ? `[${quantity.total}${quantity.unitLabel}]` : '[unparsed]'}` +
    `  ${unitPrice(c.price, quantity) != null ? `${money(unitPrice(c.price, quantity))}/${quantity.unitLabel}` : ''}`);
  console.log(`   keyword: "${target.buildKeyword(c.title)}"`);

  let candidates;
  try {
    candidates = await target.lookup(source, {});
  } catch (e) {
    console.log(`   ! Target lookup failed: ${e.message}`);
    continue;
  }

  const offers = [];
  for (const cand of candidates) {
    const m = matchConfidence(source, cand);
    const tag = { [TIER.EXACT_BARCODE]: 'TIER1', [TIER.CONFIDENT]: 'TIER2', [TIER.EQUIVALENT_UNIT]: 'UNIT' }[m.tier] || 'reject';
    const up = unitPrice(cand.price, cand.quantity);
    console.log(`   ${tag.padEnd(6)} ${money(cand.price).padStart(8)}  ${(up != null ? `${money(up)}/${cand.quantity.unitLabel}` : '').padEnd(11)}  ${cand.title.slice(0, 55)}`);
    if (m.tier === TIER.REJECT) {
      console.log(`          ↳ ${m.reasons.join('; ')}`);
      continue;
    }
    const shipping = target.shippingFor(cand.price, {});
    offers.push({
      ...cand, tier: m.tier, shipping, unitPrice: up,
      total: Math.round((cand.price + shipping) * 100) / 100,
    });
  }

  const v = buildVerdict(source, offers);
  console.log(`   => ${v.verdict}` +
    (v.best ? ` — ${v.best.retailerName} ${money(v.best.total)}` : '') +
    (v.saving ? ` (saving ${money(v.saving)})` : ''));
}

// --- Oura Ring: the unsized-goods regression -------------------------------
{
  const c = {
    name: 'Oura Ring 5 (unsized electronics — the miss)',
    title: 'Oura Ring 5 - Deep Rose - Size 8 - World’s Smallest Smart Ring - Sleep, Activity, Women’s Health, AI Advisor, 1 Week of Battery Life, Size Before You Buy, Android & iOS Compatible',
    structured: {}, barcode: null, price: 499.0, inStock: true,
  };
  const quantity = normalizeQuantity(c.title, c.structured);
  const source = { title: c.title, barcode: c.barcode, quantity, inStock: c.inStock, total: c.price, unitPrice: unitPrice(c.price, quantity) };
  console.log(`\n── ${c.name}`);
  console.log(`   Amazon: ${money(c.price)}  quantity=${quantity ? 'sized' : 'UNSIZED'}`);
  console.log(`   keyword: "${target.buildKeyword(c.title)}"`);
  try {
    const cands = await target.lookup(source, {});
    const offers = [];
    for (const cand of cands) {
      const m = matchConfidence(source, cand);
      const tag = { 1: 'TIER1', 2: 'TIER2', 3: 'UNIT' }[m.tier] || 'reject';
      const p = cand.priceRange ? `${money(cand.priceRange[0])}-${money(cand.priceRange[1])}` : money(cand.price);
      console.log(`   ${tag.padEnd(6)} ${p.padStart(16)}  ${cand.title.slice(0, 46)}${m.variantNote ? `  [${m.variantNote}]` : ''}`);
      if (m.tier === 0) { console.log(`          ↳ ${m.reasons.join('; ')}`); continue; }
      const hasPrice = cand.price != null;
      offers.push({ ...cand, tier: m.tier, variantNote: m.variantNote,
        total: hasPrice ? Math.round((cand.price + target.shippingFor(cand.price, {})) * 100) / 100 : null });
    }
    const v = buildVerdict(source, offers);
    console.log(`   => ${v.verdict}${v.best ? ` — ${v.best.retailerName} ${v.best.priceRange ? `${money(v.best.priceRange[0])}-${money(v.best.priceRange[1])}` : money(v.best.total)}` : ''}`);
  } catch (e) { console.log(`   ! ${e.message}`); }
}
