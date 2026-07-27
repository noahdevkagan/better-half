#!/usr/bin/env node
/**
 * Bump the extension version.
 *
 *   npm run bump                    0.1.0 -> 0.1.1
 *   npm run bump -- minor           0.1.5 -> 0.2.0
 *   npm run bump -- major           0.2.3 -> 1.0.0
 *   npm run bump -- "added Home Depot adapter"      patch + changelog line
 *   npm run bump -- minor "new retailer"            minor + changelog line
 *
 * Keeps manifest.json and package.json in lockstep, because a version that
 * only moves in one of them is worse than not bumping at all — you'd trust a
 * number that doesn't reflect what Chrome actually loaded.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(root, 'manifest.json');
const PACKAGE = join(root, 'package.json');
const CHANGELOG = join(root, 'CHANGELOG.md');

const LEVELS = new Set(['patch', 'minor', 'major']);

const args = process.argv.slice(2).filter(Boolean);
const level = LEVELS.has(args[0]) ? args.shift() : 'patch';
const note = args.join(' ').trim();

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Preserve the file's own formatting habits: 2-space indent, trailing newline. */
function writeJson(path, obj) {
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`);
}

function bump(version, kind) {
  const parts = String(version || '0.0.0').split('.').map((n) => parseInt(n, 10) || 0);
  const [major, minor, patch] = [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

const manifest = readJson(MANIFEST);
const pkg = readJson(PACKAGE);

// The manifest is the source of truth — it's what Chrome actually reads.
const from = manifest.version;
const to = bump(from, level);

manifest.version = to;
pkg.version = to;

writeJson(MANIFEST, manifest);
writeJson(PACKAGE, pkg);

if (note) {
  const stamp = new Date().toISOString().slice(0, 10);
  const entry = `## ${to} — ${stamp}\n\n- ${note}\n\n`;
  const existing = existsSync(CHANGELOG) ? readFileSync(CHANGELOG, 'utf8') : '# Changelog\n\n';
  const [head, ...rest] = existing.split('\n\n');
  writeFileSync(CHANGELOG, `${head}\n\n${entry}${rest.join('\n\n').trimStart()}`);
}

console.log(`  ${from}  ->  ${to}${note ? `\n  note: ${note}` : ''}`);
console.log('\n  Reload at chrome://extensions to pick it up.');
console.log(`  The popup should read v${to}.\n`);
