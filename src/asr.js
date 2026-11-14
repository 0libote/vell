'use strict';

const ASR_ENGINES = Object.freeze({
  voz: Object.freeze({
    id: 'voz',
    name: 'Voz',
    advertisedSize: '~0.4 GB',
    description: 'Desert Ant on-device engine.',
  }),
});

// Vell ships one engine. A settings file that names anything else falls back
// to it -- this only decides garbage values.
const DEFAULT_ASR_ENGINE = 'voz';

// Voz runs on the CPU through onnxruntime-node. There is no processor choice:
// one engine, one device.
const ASR_DEVICES = Object.freeze(['cpu']);

// The languages dictation is offered in: the 25 Voz covers. There is no
// auto-detect and no Hindi -- the first selected language is what the
// transcript is treated as. A language dropped from this table leaves saved
// settings cleanly: normalizeDictationLanguages discards it, and an empty
// selection becomes English.
function dictationLanguageEntry(id, name, native, engine) {
  return Object.freeze({ id, name, native: native || name, engine: engine || id });
}

const DICTATION_LANGUAGES = Object.freeze([
  dictationLanguageEntry('en', 'English', 'English'),
  dictationLanguageEntry('bg', 'Bulgarian', 'Български'),
  dictationLanguageEntry('hr', 'Croatian', 'Hrvatski'),
  dictationLanguageEntry('cs', 'Czech', 'Čeština'),
  dictationLanguageEntry('da', 'Danish', 'Dansk'),
  dictationLanguageEntry('nl', 'Dutch', 'Nederlands'),
  dictationLanguageEntry('et', 'Estonian', 'Eesti'),
  dictationLanguageEntry('fi', 'Finnish', 'Suomi'),
  dictationLanguageEntry('fr', 'French', 'Français'),
  dictationLanguageEntry('de', 'German', 'Deutsch'),
  dictationLanguageEntry('el', 'Greek', 'Ελληνικά'),
  dictationLanguageEntry('hu', 'Hungarian', 'Magyar'),
  dictationLanguageEntry('it', 'Italian', 'Italiano'),
  dictationLanguageEntry('lv', 'Latvian', 'Latviešu'),
  dictationLanguageEntry('lt', 'Lithuanian', 'Lietuvių'),
  dictationLanguageEntry('mt', 'Maltese', 'Malti'),
  dictationLanguageEntry('pl', 'Polish', 'Polski'),
  dictationLanguageEntry('pt', 'Portuguese', 'Português'),
  dictationLanguageEntry('ro', 'Romanian', 'Română'),
  dictationLanguageEntry('ru', 'Russian', 'Русский'),
  dictationLanguageEntry('sk', 'Slovak', 'Slovenčina'),
  dictationLanguageEntry('sl', 'Slovenian', 'Slovenščina'),
  dictationLanguageEntry('es', 'Spanish', 'Español'),
  dictationLanguageEntry('sv', 'Swedish', 'Svenska'),
  dictationLanguageEntry('uk', 'Ukrainian', 'Українська'),
]);

// What an engine is told for a picked language. Voz takes no language input,
// so the saved id is the wire id.
function engineLanguageId(value) {
  const id = String(value || '').trim().toLowerCase();
  const found = DICTATION_LANGUAGES.find((l) => l.id === id);
  return found ? found.engine : 'en';
}

const DICTATION_LANGUAGE_IDS = Object.freeze(DICTATION_LANGUAGES.map((l) => l.id));

function normalizeDictationLanguage(value) {
  const id = String(value || '').trim().toLowerCase();
  return DICTATION_LANGUAGE_IDS.includes(id) ? id : 'en';
}

function dictationLanguageName(value) {
  const id = normalizeDictationLanguage(value);
  const found = DICTATION_LANGUAGES.find((l) => l.id === id);
  return found ? found.name : 'English';
}

// Up to three languages, the first being the main one. Voz takes no language
// input and cannot detect, so the first selected language is what the
// transcript is treated as.
const MAX_DICTATION_LANGUAGES = 3;

function normalizeDictationLanguages(value) {
  const raw = Array.isArray(value) ? value : (value == null ? [] : String(value).split(','));
  const out = [];
  for (const item of raw) {
    const id = String(item || '').trim().toLowerCase();
    if (!DICTATION_LANGUAGE_IDS.includes(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length === MAX_DICTATION_LANGUAGES) break;
  }
  return out.length ? out : ['en'];
}

function dictationLanguageNames(value) {
  return normalizeDictationLanguages(value).map(dictationLanguageName);
}

// Voz covers every offered language on-device, so the picker is never locked
// and the limit is the UI's own cap.
function dictationLanguageUnlocked() {
  return true;
}

function dictationLanguageLimit() {
  return MAX_DICTATION_LANGUAGES;
}

function offeredDictationLanguages() {
  return DICTATION_LANGUAGES;
}

// What to keep on disk. Voz covers every offered language locally, so any
// valid selection is kept.
function constrainDictationLanguages(list) {
  return normalizeDictationLanguages(list);
}

// What the recogniser is told. Voz takes no language input and cannot detect,
// so the first selected language wins; the picker always offers the full list.
function wireLanguage(list) {
  return engineLanguageId(normalizeDictationLanguages(list)[0]);
}

// Voz runs on the CPU through onnxruntime-node. There is no processor choice.
const DEVICE_LABELS = Object.freeze({
  cpu: 'CPU',
});

function normalizeAsrEngine(value) {
  const id = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(ASR_ENGINES, id) ? id : DEFAULT_ASR_ENGINE;
}

function normalizeAsrDevice() {
  return 'cpu';
}

// Voz is the only engine and it runs on the CPU.
function deviceLabel() {
  return 'CPU';
}

// With a single engine there is no faster path to prefer.
function prefersFastAsr() {
  return false;
}

function engineName(value) {
  return ASR_ENGINES[normalizeAsrEngine(value)].name;
}

function engineOptionLabel(value) {
  const engine = ASR_ENGINES[normalizeAsrEngine(value)];
  return engine.name + ' \u00b7 ' + engine.advertisedSize;
}

function stripAnsi(value) {
  return String(value || '').replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '');
}

function clampPercent(value) {
  const percent = Number(value);
  if (!Number.isFinite(percent)) return null;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

function isParentProgressLabel(detail) {
  return /^(Fetching\s+\d+\s+files|Loading checkpoint shards)$/i.test(String(detail || '').trim());
}

function lastMatch(regex, text) {
  regex.lastIndex = 0;
  let found = null;
  let match;
  while ((match = regex.exec(text)) !== null) found = match;
  regex.lastIndex = 0;
  return found;
}

function parseEngineProgress(previousBuffer, chunk) {
  const combined = stripAnsi(String(previousBuffer || '') + String(chunk || ''));
  const markerRe = /VOXDEN_PROGRESS\s+(\d{1,3})\s+([^\r\n]*)/g;
  const fetchingRe = /Fetching\s+(\d+)\s+files:\s*(\d{1,3})%(?:\|[^\r\n]*?\|\s*(\d+)\s*\/\s*(\d+))?/gi;
  const loadingRe = /Loading checkpoint shards:\s*(\d{1,3})%/gi;
  const fileRe = /(?:^|[\r\n])([^\r\n:]{1,120}):\s*(\d{1,3})%\|/g;

  const loadingMatch = lastMatch(loadingRe, combined);
  const fetchingMatch = lastMatch(fetchingRe, combined);
  let fileMatch = null;
  let fileScan;
  while ((fileScan = fileRe.exec(combined)) !== null) {
    const detail = String(fileScan[1] || '').trim();
    if (isParentProgressLabel(detail)) continue;
    fileMatch = fileScan;
  }

  let markerMatch = null;
  let markerScan;
  while ((markerScan = markerRe.exec(combined)) !== null) {
    const detail = String(markerScan[2] || '').trim();
    if (isParentProgressLabel(detail)) continue;
    markerMatch = markerScan;
  }

  const loadingIndex = loadingMatch ? loadingMatch.index : -1;
  const downloadIndex = Math.max(
    fetchingMatch ? fetchingMatch.index : -1,
    fileMatch ? fileMatch.index : -1,
    markerMatch ? markerMatch.index : -1
  );

  if (loadingMatch && loadingIndex >= downloadIndex) {
    const percent = clampPercent(loadingMatch[1]);
    return {
      buffer: combined.slice(-4096),
      progress: percent == null ? null : {
        index: loadingMatch.index,
        phase: 'loading',
        percent,
        detail: '',
      },
    };
  }

  const filePercent = fileMatch ? clampPercent(fileMatch[2]) : null;
  const markerPercent = markerMatch ? clampPercent(markerMatch[1]) : null;
  const fetchingPercent = fetchingMatch ? clampPercent(fetchingMatch[2]) : null;
  const percents = [filePercent, markerPercent, fetchingPercent].filter((value) => value != null);
  if (!percents.length) {
    return { buffer: combined.slice(-4096), progress: null };
  }

  const percent = Math.max.apply(null, percents);
  const detail = markerMatch
    ? String(markerMatch[2] || '').trim().slice(-64)
    : (fileMatch ? String(fileMatch[1] || '').trim().slice(-64) : '');
  const index = Math.max(
    fileMatch ? fileMatch.index : -1,
    markerMatch ? markerMatch.index : -1,
    fetchingMatch ? fetchingMatch.index : -1
  );
  return {
    buffer: combined.slice(-4096),
    progress: {
      index,
      phase: 'downloading',
      percent,
      detail,
    },
  };
}

module.exports = {
  ASR_ENGINES,
  DEFAULT_ASR_ENGINE,
  ASR_DEVICES,
  DEVICE_LABELS,
  DICTATION_LANGUAGES,
  DICTATION_LANGUAGE_IDS,
  normalizeDictationLanguage,
  dictationLanguageName,
  MAX_DICTATION_LANGUAGES,
  normalizeDictationLanguages,
  dictationLanguageNames,
  dictationLanguageUnlocked,
  dictationLanguageLimit,
  offeredDictationLanguages,
  constrainDictationLanguages,
  wireLanguage,
  engineLanguageId,
  normalizeAsrEngine,
  normalizeAsrDevice,
  deviceLabel,
  prefersFastAsr,
  engineName,
  engineOptionLabel,
  parseEngineProgress,
};
