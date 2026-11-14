'use strict';

// The capability contract is the thing that stops a vocabulary request being
// accepted and thrown away. Vell ships one engine -- Desert Ant Voz -- so the
// contract is small: no context input (repair always), no auto-detect, and a
// planner that can only ever pick Voz.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const caps = require('../src/asr-capabilities');

let checks = 0;
function ok(label, value) {
  assert.ok(value, label);
  checks += 1;
  process.stdout.write('ok ' + label + '\n');
}
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label + ': ' + JSON.stringify(actual));
  checks += 1;
  process.stdout.write('ok ' + label + '\n');
}

// --- 1. One engine, fully described -------------------------------------------

eq('the catalog holds only Voz', caps.ENGINE_IDS, ['voz']);
const voz = caps.capabilitiesFor('voz');
eq('voz vocabulary is not supported in-model', voz.vocabulary.supported, false);
eq('voz has no context mechanism', voz.vocabulary.mechanism, null);
eq('voz covers 25 languages', voz.languages.length, 25);
ok('voz includes English', voz.languages.includes('en'));
ok('voz excludes Hindi', !voz.languages.includes('hi'));
ok('voz has no auto-detect', voz.autoDetectLanguage === false);
ok('voz reports word segments', voz.segments === true);
ok('voz reports timestamps', voz.timestamps === true);
ok('voz reports no confidence', voz.confidence === false);

// --- 2. The mechanisms are the real ones --------------------------------------

eq('voz vocabulary goes via repair', caps.vocabularyRoute('voz', 3), 'repair');
eq('no terms means no vocabulary route', caps.vocabularyRoute('voz', 0), 'none');
ok('voz reports no vocabulary support', !caps.supportsVocabulary('voz'));
eq('an unknown engine normalises to voz', caps.normalizeEngine('whisper'), 'voz');
eq('and so does an empty one', caps.normalizeEngine(''), 'voz');

// --- 3. Routing can never leave Voz --------------------------------------------

const plain = caps.planRoute({ engine: 'voz', language: 'en', termCount: 12 });
eq('the planner keeps Voz', plain.engine, 'voz');
eq('nothing falls back', plain.fallbackFrom, null);
ok('nothing is marked degraded', !plain.degraded);
eq('terms go via repair', plain.vocabularyVia, 'repair');

const noTerms = caps.planRoute({ engine: 'voz', language: 'en', termCount: 0 });
eq('with an empty dictionary there is nothing to protect', noTerms.vocabularyVia, 'none');

const unsupported = caps.planRoute({ engine: 'voz', language: 'hi', termCount: 3 });
eq('an unsupported language is reported, not hidden', unsupported.degraded, true);
ok('and names the language', unsupported.lostCapabilities.includes('language:hi'));
ok('and names Voz in the reason', /Voz/i.test(unsupported.reason));

// --- 4. What the user is told ---------------------------------------------------

ok('the description names the engine', /^Voz\b/.test(caps.describeRoute(plain, { device: 'CPU' })));
ok('and says the dictionary was applied afterwards',
  /after recognition/.test(caps.describeRoute(plain, { device: 'CPU' })));
eq('the compact line is just Voz when no dictionary applies',
  caps.summarizeRoute(noTerms, {}), 'Voz');
eq('and names repair when terms applied afterwards',
  caps.summarizeRoute(plain, {}), 'Voz · dictionary applied after recognition');

// --- 5. The runtime dependency is pinned ---------------------------------------

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
ok('onnxruntime-node is a runtime dependency, not a devDependency',
  !!(pkg.dependencies && pkg.dependencies['onnxruntime-node']));
ok('the Voz SDK is a runtime dependency',
  !!(pkg.dependencies && pkg.dependencies['@desert-ant-labs/voz']));

process.stdout.write('all ' + checks + ' ASR capability checks passed\n');
