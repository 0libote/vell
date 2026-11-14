'use strict';

const assert = require('assert');
const fs = require('fs');
const harness = require('./asr-test-harness');

(async () => {
  const h = harness();
  try {
    // A tone changes capitals and punctuation; every word survives.
    const input = 'Hello, I am going to send the notes when we are done. Thank you.';
    const expected = {
      formal: input,
      casual: input,
      veryCasual: 'hello, I am going to send the notes when we are done. thank you',
    };
    h.context.sample = input;
    h.run('applySystemSettings = () => {}; sendOverlay = () => {}; broadcast = () => {};');
    const set = patch => h.handlers.get('settings-set')({}, patch);
    for (const category of ['personal', 'work', 'email', 'other']) {
      h.context.category = category;
      for (const [tone, text] of Object.entries(expected)) {
        await set({ writingStyles: { [category]: tone } });
        h.run('loadSettings()');
        for (const quality of ['fast', 'accurate']) {
          h.context.quality = quality;
          assert.strictEqual(h.run('composeTranscript(sample, style.toneForCategory(category, settings.writingStyles), quality).text'), text, category + '/' + tone + '/' + quality);
        }
      }
    }
    h.run("dictionary.phrases = [{ from: 'he is we', to: 'He Is We', kind: 'replacement' }]; saveDict();");
    assert(h.run("composeTranscript('I am listening to he is we', 'veryCasual', 'fast').text").includes('He Is We'));

    // Spoken corrections are off until turned on. Then what the speaker took
    // back is gone, and the history entry says what was taken out.
    h.context.takenBack = 'The cat is running on the field, no, no, in the park.';
    // A release build leaves them out, whatever a settings file says: no
    // switch, nothing applied, nothing sent.
    await set({ spokenCorrections: true });
    assert.strictEqual(h.run('spokenCorrectionsAvailable()'), false, 'the harness runs as a packaged build');
    assert.strictEqual(h.run("composeTranscript(takenBack, 'casual', 'fast').text"), h.context.takenBack);
    assert.strictEqual(h.run('snapshot().spokenCorrectionsAvailable'), false, 'and Settings hides the switch');
    await set({ spokenCorrections: false });
    // A development build, or VOXDEN_SPOKEN_CORRECTIONS=1, has them.
    h.run("process.env.VOXDEN_SPOKEN_CORRECTIONS = '1'");
    assert.strictEqual(h.run('snapshot().spokenCorrectionsAvailable'), true);
    assert.strictEqual(h.run('settings.spokenCorrections'), false);
    assert.strictEqual(h.run("composeTranscript(takenBack, 'casual', 'fast').text"), h.context.takenBack, 'off by default');
    await set({ spokenCorrections: true });
    h.run('loadSettings()');
    assert.strictEqual(h.run('settings.spokenCorrections'), true, 'the choice is saved');
    const fixed = JSON.parse(h.run("JSON.stringify(composeTranscript(takenBack, 'casual', 'fast'))"));
    assert.strictEqual(fixed.text, 'The cat is running in the park.');
    assert.deepStrictEqual(fixed.meta.spokenCorrections, ['on the field, no, no,']);
    assert.strictEqual(fixed.meta.afterCorrections, 'The cat is running in the park.');
    assert.strictEqual(h.run("composeTranscript('Meet at three, no, four.', 'casual', 'fast').text"), 'Meet at four.');
    assert.strictEqual(h.run("composeTranscript('Sorry, my bad, it closed.', 'casual', 'fast').text"), 'Sorry, my bad, it closed.',
      'an apology is not a correction');
    h.run("(() => { const c = composeTranscript(takenBack, 'casual', 'fast'); addHistoryEntry(c.text, c.meta); })()");
    const entry = JSON.parse(h.run('JSON.stringify(history.entries[0])'));
    assert.strictEqual(entry.text, 'The cat is running in the park.');
    assert.strictEqual(entry.original, h.context.takenBack, 'what was said is kept');
    assert.deepStrictEqual(entry.spokenCorrections, ['on the field, no, no,']);
    const plain = JSON.parse(h.run("(() => { const c = composeTranscript('Nothing to take back here.', 'casual', 'fast'); addHistoryEntry(c.text, c.meta); return JSON.stringify(history.entries[0]); })()"));
    assert.strictEqual(plain.spokenCorrections, undefined, 'an entry with nothing taken out says nothing');
    assert.strictEqual(plain.afterCorrections, undefined);

    // Model take-back was a cloud feature. Without it, the local rules above
    // are the whole story: no model is ever asked.
    await set({ verbatimMode: true });
    assert.strictEqual(h.run("composeTranscript(sample, 'veryCasual', 'fast').text"), input);
    assert.strictEqual(h.run("composeTranscript(takenBack, 'casual', 'fast').text"), h.context.takenBack,
      'verbatim keeps every word, corrections too');
    await set({ verbatimMode: false });

    // Upgrade from an old settings file. A hidden preference must never send.
    const settingsFile = h.run('SETTINGS_FILE');
    const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    fs.writeFileSync(settingsFile, JSON.stringify({ ...saved, autoSend: { work: 'enter', email: 'ctrl-enter' } }));
    h.run('loadSettings()');
    assert.strictEqual(h.run('settings.autoSend'), undefined);
    assert.strictEqual((await set({ autoSend: { work: 'enter' } })).autoSend, undefined);
    assert.strictEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).autoSend, undefined);
    h.run(`var pasteCalls = [];
      clipboardPaste = { paste: async (text, action) => { pasteCalls.push(['clipboard', text]); return action(); } };
      ps = async args => { pasteCalls.push(args); return 'VELL_OK'; };
      settings.autoSend = { work: 'enter', email: 'ctrl-enter' };
      prepareCorrectionLearning = async () => null;`);
    await h.run("pasteDictation('A draft to review.', 'work')");
    await h.run("pasteDictation('Another draft.', 'email')");
    assert.deepStrictEqual(JSON.parse(h.run('JSON.stringify(pasteCalls.map(call => call[0]))')), ['clipboard', 'paste', 'clipboard', 'paste']);
  } finally { await h.close(); }
  console.log('Writing style integration: all contexts and qualities, saved tones, dictionary, verbatim, and removal of auto-send passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
