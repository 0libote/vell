'use strict';

// The dictionary's whole lifecycle under Voz: terms are ranked for the repair
// stage (there is no in-model prompt to fill), the ranking survives reload,
// and history records what ran and how the dictionary was applied.
// No speech model is loaded: transcription itself is covered by
// test-transcription-provider.js and the PoC in docs/VOZ-SPIKE.md.

const assert = require('assert');
const path = require('path');
const harness = require('./asr-test-harness');

let checks = 0;
function ok(label, value) {
  assert.ok(value, label);
  checks += 1;
  process.stdout.write('ok ' + label + '\n');
}
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label + ' got: ' + JSON.stringify(actual));
  checks += 1;
  process.stdout.write('ok ' + label + '\n');
}

const h = harness();

function addTerm(from, to, meta) {
  const handler = h.handlers.get('dict-upsert');
  assert.ok(handler, 'main.js must expose the dict-upsert handler');
  return handler(null, from, to, meta);
}

async function main() {
  try {
    ok('this test profile is not the installed Vell dictionary',
      !/appdata[\\/]+roaming[\\/]+vell[\\/]+data/i.test(h.run('DICT_FILE')));
    ok('and it is not the development dictionary either',
      path.normalize(h.run('DICT_FILE')) !== path.normalize(path.join(__dirname, '..', 'data', 'dictionary.json')));

    // --- 1. The route always runs Voz; terms always go via repair ------------
    eq('the route runs Voz', h.run('planDictationRoute({}).engine'), 'voz');
    eq('with no fallback engine', h.run('planDictationRoute({}).fallbackFrom'), null);
    eq('terms go via repair', h.run("planDictationRoute({ termCount: 3 }).vocabularyVia"), 'repair');
    eq('and nothing with no terms', h.run("planDictationRoute({ termCount: 0 }).vocabularyVia"), 'none');
    eq('an unknown engine still resolves to Voz', h.run("planDictationRoute({ engine: 'whisper' }).engine"), 'voz');

    // --- 2. A word added now is ranked first for repair -----------------------
    await addTerm('Kharagpur', 'Kharagpur', { kind: 'word' });
    const ranked = h.run("vocabularyForDictation('en').map(e => e.canonical)");
    ok('the next dictation sees the new word', ranked.includes('Kharagpur'));
    eq('and the newest term leads', ranked[0], 'Kharagpur');

    await addTerm('Bhubaneswar', 'Bhubaneswar', { kind: 'word' });
    const ranked2 = h.run("vocabularyForDictation('en').map(e => e.canonical)");
    ok('a second word joins it', ranked2.includes('Bhubaneswar'));
    ok('and the newest term still leads', ranked2[0] === 'Bhubaneswar');

    // --- 3. It survives a restart ----------------------------------------------
    h.run('loadStores();');
    const afterRestart = h.run("vocabularyForDictation('en').map(e => e.canonical)");
    ok('both words survive a reload from disk',
      afterRestart.includes('Kharagpur') && afterRestart.includes('Bhubaneswar'));

    // --- 4. A dictionary far larger than any prompt window ---------------------
    for (let i = 0; i < 300; i++) {
      await addTerm('Terminology' + i, 'Terminology' + i, { kind: 'word' });
    }
    eq('the dictionary really is that large', h.run('currentVocabulary().length'), 302);
    const rankedMany = h.run("vocabularyForDictation('en')");
    eq('ranking keeps all of it', rankedMany.length, 302);
    eq('and nothing goes in-model', h.run("vocabularyForDictation('en').length"), 302);

    // --- 5. The language is explicit, never detected -----------------------------
    h.run("settings.dictationLanguages = ['pt']; settings.dictationLanguage = 'pt';");
    eq('an explicit language is honoured', h.run('textLanguage()'), 'pt');
    eq('the route carries it', h.run("planDictationRoute({}).language"), 'pt');
    const routeDe = h.run("JSON.stringify(planDictationRoute({ language: 'de' }))");
    eq('and any offered language routes cleanly',
      h.run("planDictationRoute({ language: 'de' }).language"), 'de');

    // --- 6. The finalized text, and what is recorded about it ------------------
    h.run(`
      settings.dictationLanguage = 'en'; settings.dictationLanguages = ['en'];
      settings.verbatimMode = false;
      lastAsrReport = { engine: 'voz', device: 'cpu', vocabulary: '', routed: 'voz', segments: null };
      lastVocabularyReport = { engine: 'voz', device: 'cpu', language: 'en', via: 'repair', offered: 1, mechanism: 'repair' };
      var pasted = null;
      pasteDictation = function (text) { pasted = text; return Promise.resolve(); };
    `);
    await addTerm('carrot pur', 'Kharagpur', { kind: 'mapping' });
    await h.run("onTranscript('we met in carrot pur last year')");
    ok('an explicit rule is applied to the transcript', /Kharagpur/.test(h.run('pasted')));

    const entry = h.run('history.entries[0]');
    ok('the dictation records what the vocabulary did', entry.vocabulary);
    eq('including which engine ran', entry.vocabulary.engine, 'voz');
    eq('and that the dictionary was applied afterwards',
      entry.vocabulary.vocabularyVia, 'repair');
    ok('and how many replacements were made', entry.vocabulary.dictionaryHits >= 1);
    ok('the record carries no transcript text',
      !JSON.stringify(entry.vocabulary).includes('we met in'));
    ok('and the summary is readable',
      /Voz/.test(entry.vocabulary.summary)
      && /after recognition/.test(entry.vocabulary.summary));

    // --- 7. The dictionary leaves ordinary speech for the selected tone --------
    await h.run("onTranscript('we will get the file later')");
    eq('a sentence with nothing to correct keeps its words through the dictionary',
      h.run('history.entries[0].afterDictionary'), 'We will get the file later');
    eq('the casual tone keeps the words as they were said',
      h.run('pasted'), 'We will get the file later');
    eq('and records no dictionary hits',
      h.run('history.entries[0].vocabulary.dictionaryHits'), 0);
  } finally { await h.close(); }
  process.stdout.write('all ' + checks + ' vocabulary lifecycle checks passed\n');
}

main().catch(async (err) => {
  await h.close();
  process.stderr.write(String((err && err.stack) || err) + '\n');
  process.exit(1);
});
