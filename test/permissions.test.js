import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(
  await readFile(new URL('../manifest.json', import.meta.url), 'utf8'),
);

test('site access is explicit instead of broad', () => {
  const patterns = [
    ...(manifest.host_permissions || []),
    ...(manifest.optional_host_permissions || []),
    ...(manifest.content_scripts || []).flatMap((script) => script.matches || []),
  ];

  assert.ok(!patterns.includes('<all_urls>'));
  assert.ok(!patterns.some((pattern) => ['*://*/*', 'http://*/*', 'https://*/*'].includes(pattern)));
  assert.deepEqual(manifest.optional_host_permissions, ['https://www.costco.com/*']);
});

test('Costco access is narrow and optional', () => {
  assert.ok(!manifest.host_permissions.includes('https://www.costco.com/*'));
  assert.ok(manifest.optional_host_permissions.includes('https://www.costco.com/*'));
});

test('the Amazon order scan uses site access, not browser-history access', () => {
  assert.ok(!manifest.permissions.includes('history'));
  const staticFiles = manifest.content_scripts.flatMap((script) => script.js || []);
  assert.ok(staticFiles.includes('src/content/amazon-orders.js'));
});

test('checkout access is temporary and user-invoked', () => {
  assert.ok(manifest.permissions.includes('activeTab'));
  assert.ok(manifest.permissions.includes('scripting'));
  assert.ok(!manifest.permissions.includes('tabs'));

  const staticFiles = (manifest.content_scripts || []).flatMap((script) => script.js || []);
  assert.ok(!staticFiles.includes('src/content/coupon-runner.js'));
});

test('coupon sources have only their explicit host access', () => {
  assert.ok(manifest.host_permissions.includes('https://simplycodes.com/*'));
  assert.ok(manifest.host_permissions.includes('https://couponfollow.com/*'));
});
