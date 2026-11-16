'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { replace, writeJson, readJson } = require('../src/atomic-store');

let failed = 0;
function ok(name, fn) {
  try { fn(); console.log('ok ' + name); }
  catch (err) { failed += 1; console.error('FAIL ' + name + '\n  ' + (err && err.stack || err)); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vell-atomic-'));
ok('replace writes atomically', () => {
  const f = path.join(dir, 'store.json');
  replace(f, '{"a":1}');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), '{"a":1}');
});

ok('writeJson mirrors to .bak', () => {
  const f = path.join(dir, 'data.json');
  writeJson(f, { a: 1 });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { a: 1 });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f + '.bak', 'utf8')), { a: 1 });
});

ok('readJson recovers from backup', () => {
  const f = path.join(dir, 'rec.json');
  writeJson(f, { ok: true });
  fs.writeFileSync(f, 'damaged{{{');
  assert.deepStrictEqual(readJson(f, null), { ok: true });
});

ok('readJson returns fallback when both missing', () => {
  assert.strictEqual(readJson(path.join(dir, 'nope.json'), 'fb'), 'fb');
});

ok('readJson rejects invalid via validate', () => {
  const f = path.join(dir, 'inv.json');
  writeJson(f, [1, 2]);
  assert.deepStrictEqual(readJson(f, 'fb', (v) => v && !Array.isArray(v) && typeof v === 'object'), 'fb');
});

if (failed) { console.error(failed + ' atomic-store tests failed'); process.exit(1); }
console.log('all atomic-store tests passed');
