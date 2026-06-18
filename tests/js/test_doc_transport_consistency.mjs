// Regression guard for DEAD-040 / DEAD-041: the docs drifted from the real brick
// transport. Reality (verified in brick-loader.js / brick-decode-worker.js /
// 3-chunk_packer.py): bricks are 64³, mosaicked 8×8 into 512² WebP tiles, packed
// into .bin packs fetched WHOLE (no HTTP range), decoded via createImageBitmap in
// a worker pool. NOT gzip, NOT PNG, NOT range requests, and BRICK_SIZE is 64 (not 128).
//
// Run: node tests/js/test_doc_transport_consistency.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const claude = readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');

// ── CLAUDE.md (DEAD-040 / DEAD-041) ──
assert.ok(!/BRICK_SIZE = 128/.test(claude), 'DEAD-041: CLAUDE.md no longer claims BRICK_SIZE = 128');
assert.ok(!/legacy constant/.test(claude), 'DEAD-041: stale "legacy constant" caveat removed');
assert.ok(/BRICK_SIZE = 64/.test(claude), 'DEAD-041: CLAUDE.md states BRICK_SIZE = 64');
assert.ok(!/gzip/i.test(claude), 'DEAD-040: CLAUDE.md no longer mentions gzip');
assert.ok(!/range fetch/i.test(claude), 'DEAD-040: "range fetch" removed from the pipeline diagram');
assert.ok(!/512² PNG/.test(claude), 'DEAD-040: "512² PNGs" corrected to WebP');
assert.ok(/WebP/.test(claude), 'DEAD-040: CLAUDE.md describes the real WebP transport');

// ── README.md (DEAD-040) ──
assert.ok(!/gunzip/i.test(readme), 'DEAD-040: README no longer says gunzip');
assert.ok(!/gzip-pack/i.test(readme), 'DEAD-040: README no longer says gzip-pack');
assert.ok(!/HTTP range requests/.test(readme), 'DEAD-040: README no longer claims HTTP range requests');
assert.ok(!/512² PNG/.test(readme), 'DEAD-040: README "512² PNGs" corrected');
assert.ok(/WebP/.test(readme), 'DEAD-040: README describes the real WebP transport');

console.log('doc transport consistency (DEAD-040/041): OK');
