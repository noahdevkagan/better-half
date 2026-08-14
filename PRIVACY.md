# Better Half Privacy Policy

Effective date: August 14, 2026

Better Half is a comparison-shopping Chrome extension that compares product prices and tests coupon codes at checkout. It does not require an account, include analytics or advertising, use affiliate links, or send data to Better Half or its developer.

## Information the extension handles

Better Half handles the minimum information needed to provide its shopping features:

- Website content and browsing context, including the current page's domain or URL, Amazon product details, user-invoked Amazon order-history details from the last 30 days, retailer search results, checkout totals and subtotals, discount fields, and coupon outcomes.
- Settings entered in the extension, including feature toggles, a five-digit ZIP code, Amazon Prime status, and Target RedCard status.
- A local coupon ledger containing a merchant domain, coupon code, outcome, observed discount percentage, observed minimum spend, and the time it was tested.
- A local savings history containing the amount, saving type, and time recorded.

Better Half may check whether a supported payment-card field contains characters so it can stop before testing coupons after payment details have been entered. It does not copy, store, or transmit payment-card values.

## How information is used

Information is used only to provide Better Half's user-facing features: matching products, calculating price and shipping comparisons, checking current prices for recent Amazon purchases when requested, preparing a price-adjustment message for the user to review, finding candidate coupon codes, testing those codes against the user's current cart, remembering coupon outcomes, and displaying savings.

To perform price comparisons, product search terms or identifiers are sent directly from the user's browser over HTTPS to Target, Walmart, Home Depot and, only after the user enables it, Costco.com. Recent-purchase price checks load the corresponding Amazon product pages directly from the user's browser. To find candidate coupon codes, a merchant domain may be used to load a corresponding page from SimplyCodes or CouponFollow. These requests go directly to those third-party sites and are subject to their respective privacy practices. Amazon order numbers and purchase details, cart totals, payment-card values, the local coupon ledger, and the local savings history are not sent to the developer or to unrelated retailers.

## Storage and retention

Settings, coupon outcomes, and savings history are stored locally using Chrome's extension storage. A temporary worker-window identifier may be stored for the current browser session so the extension can clean up tabs it created. Better Half does not use cloud sync or a developer-operated server.

Amazon order numbers, purchase details, and prepared adjustment requests are not stored by Better Half. They remain in memory only while the user-invoked scan is running or on the open results page.

Local data remains until the user clears the extension's stored data or uninstalls the extension.

## Sharing, sale, and advertising

Better Half does not sell user data. It does not share user data with the developer, data brokers, advertisers, or analytics providers. It does not use user data for advertising, credit decisions, or purposes unrelated to its comparison-shopping features.

## Limited Use

Better Half's use of user data is limited to providing and improving its disclosed, user-facing comparison-shopping features. The extension complies with the Chrome Web Store User Data Policy, including the Limited Use requirements.

## Changes

Material changes to this policy will be posted on this page with an updated effective date.

## Contact

Questions or requests about this policy may be submitted through the project's support page: https://github.com/noahdevkagan/better-half/issues
