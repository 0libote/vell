'use strict';

const { app, BrowserWindow, dialog, globalShortcut, ipcMain, clipboard, screen, Tray, Menu, nativeImage, powerMonitor, safeStorage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { cleanup, cleanupVerbatim, dedupeRepeats } = require('./cleanup');
const { applySpokenCorrections } = require('./spoken-corrections');
const { autoCleanup } = require('./auto-cleanup');
const { spokenNumbersToDigits } = require('./numbers');
const dict = require('./dictionary');
const vocabulary = require('./vocabulary');
const { createCorrectionObserver } = require('./correction-observer');
const { createCorrectionTracker } = require('./correction-learning');
const autoDictionary = require('./auto-dictionary');
const repair = require('./repair');
const capabilities = require('./asr-capabilities');
const modelPlan = require('./model-plan');
const style = require('./style');
const metrics = require('./metrics');
const insights = require('./insights');
const corpus = require('./corpus');
const historyStore = require('./history-store');
const { createHistoryUsage } = require('./history-usage');
const { createClipboardPaste, readRestorable } = require('./clipboard-paste');
const { ownWindowId } = require('./window-id');
const macShell = require('./mac-shell');
const asr = require('./asr');
const hotkeys = require('./hotkeys');
const flowBar = require('./flow-bar');
const { normalizePreference: normalizeFlowMotion } = require('./flow-motion');
const appTheme = require('./app-theme');
const { createHealthMonitor, createFrameMonitor, timerLateness } = require('./overlay-health');
const { createDiagLog } = require('./diag');
const announcements = require('./announcements');
const { createMediaController } = require('./media-controller');
const { VozModelManager } = require('./voz-model');
const { createProvider, ensureVoz } = require('./transcription-provider');
const cleanRemove = require('./clean-remove');
const elevation = require('./elevation');

app.setName('Vell');
if (process.platform === 'win32') {
  app.setAppUserModelId('com.vell.app');
}
// One --disable-features value: a second appendSwitch for the same key
// replaces the first rather than adding to it.
//
// CalculateNativeWinOcclusion: Chromium's Windows occlusion tracker decides
// the flow bar is covered whenever another topmost window sits over it or the
// display powers off, and RenderWidgetHostViewAura::HideImpl then hides the
// page's input child window (Chrome_RenderWidgetHostHWND). The matching
// re-show never runs for the overlay, because backgroundThrottling: false
// keeps its host from ever counting as hidden (Electron's disable_hidden
// patch), so the bar came back painting but deaf to every click and drag
// until something resized the window. Measured with real OS clicks on
// Electron 36: covered for 4 s by another app's window, or one display
// off/on cycle, and the page never saw pointerdown again; with the feature
// off, both leave input intact. The cost is that a covered dashboard is not
// throttled by occlusion; hidden and minimized windows still are.
app.commandLine.appendSwitch('disable-features', 'OverlayScrollbar,CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-blink-features', 'OverlayScrollbars');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let overlayWin = null;
let historyWin = null;
let historySnapshotPending = true;
let tray = null;
// Last built menu's signature, so a rebuild only happens when the menu would
// actually come out different.
let trayMenuSig = '';
// A settings pane the tray asked for before the window had loaded.
let pendingSettingsCat = '';
// Audio inputs, reported by the renderer. Only a renderer can enumerate them,
// and the tray needs the list to offer a picker rather than a link.
let micDevices = [];
let micDefaultId = '';
let lastHwnd = '0';
let lastExternalHwnd = '0';
let lastTarget = { hwnd: '0', exe: '', title: '' };
let overlayHwnd = '0';
let historyHwnd = '0';
let mode = 'idle';
let engineError = '';
let engineProgress = null;
// Set when a hotkey could not be registered at launch and the app fell back to
// a different chord. Shown in settings until the shortcut is changed.
let hotkeyNotice = '';
let pttReleasePending = false;
// Only the shortcut that began a physical hold can release or cancel it.
let pttOwner = null;
let hwndTimer = null;
let sidecarReady = false;
let sidecarState = 'starting';
let sidecarStartRequested = false;
let asrOperation = null;
let asrSetupController = null;
let sidecarReadyWaiters = [];
let recordingStartedAt = 0;
let lastDurationMs = 0;
let dictationTiming = null;
// The wait before the bar listens, from the shortcut press: when the start cue
// cleared, when other audio was paused, how long the microphone took. Filled in
// while arming, written to the history entry with the stop-to-paste figures
// (metrics.armTimingFields). Null outside a live dictation.
let armTiming = null;
let successTimer = null;
let isQuitting = false;
let dictionary = { phrases: [], variants: [] };
// Structured vocabulary derived from `dictionary`, rebuilt whenever the
// dictionary is edited. Kept as a cache rather than as the store: the
// dictionary file stays the thing the UI edits and the thing an older Vell
// can still read, and this is the ranked, script-aware view of it that the
// engines and the repair stage actually consume.
let vocabularyEntries = [];
let vocabularyDirty = true;
// What the last dictation's vocabulary actually did, for the diagnostics
// panel. Never contains audio or transcript text -- only term names the user
// typed in themselves and the decisions taken about them.
let lastVocabularyReport = null;
// What Voz reported about the dictation it just finished.
let lastAsrReport = null;
let history = { entries: [] };
let historyAnalyticsRevision = 0;
const historyUsage = createHistoryUsage();
// What the bell has already told this user about. Ids stay in here after they
// are cleared, which is the only reason a cleared notification stays gone.
let notifications = { seenVersion: '', items: {} };
// The game shortcut: one key, toggled, that dictates into a game the game's way
// -- its sound stays on, the keys a player holds are left alone, a game they
// have left is not pulled back to the front. F8 because the keys around it are
// taken: F5 and F9 are quicksave and quickload in many games, F12 is Steam's
// screenshot. The user can pick any other.
const GAME_SHORTCUT_DEFAULT = 'F8';
// Whether the dictation in progress was started with the game shortcut.
let gameDictation = false;
let settings = {
  appTheme: 'voxden',
  dictateMode: 'toggle',
  shortcut: hotkeys.defaultShortcut(),
  pasteLastShortcut: 'CommandOrControl+Alt+V',
  gameShortcut: GAME_SHORTCUT_DEFAULT,
  gameShortcutEnabled: false,
  launchAtLogin: false,
  alwaysShowFlowBar: false,
  flowBarStyle: 'island',
  flowBarMotion: 'system',
  // Where the user dragged the flow bar to, as the screen point its bottom
  // centre sits on. null means "wherever the primary display's bottom centre
  // is", which is where it has always been.
  flowBarAnchor: null,
  showInTaskbar: false,
  soundsEnabled: true,
  suggestionsEnabled: true,
  keepTrainingAudio: false,
  keepRecordings: false,
  // Minutes of inactivity before the in-process Voz model is dropped to free
  // ~1GB of RAM. 0 means never unload. Next dictation reloads it (~1-2s).
  modelUnloadMinutes: 15,
  asrEngine: asr.DEFAULT_ASR_ENGINE,
  asrDevice: 'auto',
  dictationLanguage: 'en',
  dictationLanguages: ['en'],
  microphone: 'default',
  displayName: '',
  // The address the greeting name belongs to, so another account's name is
  // not left on screen. Empty for a name that predates this.
  displayNameFrom: '',
  muteMusicWhileDictating: true,
  writingStyles: Object.assign({}, style.DEFAULT_WRITING_STYLES),
  verbatimMode: false,
  verbatimDictionary: false,
  // Spoken numbers written as figures: "one point zero point sixteen" is
  // 1.0.16, "twenty five percent" is 25%.
  numbersAsDigits: true,
  autoCleanup: false,
  // "On the field, no, in the park" pastes "in the park" (src/spoken-corrections.js).
  spokenCorrections: false,
};

let vozModelManager = null;
// One state for the whole first-run setup. The engine and the weights are two
// downloads but not two decisions -- neither is any use without the other, so
// the user is shown one operation with one bar.
// What each engine can actually run on this PC, as reported by the sidecar's
// --check. Empty until the first check answers.
let engineAvailability = {};
let asrRuntimeState = {
  status: 'idle',
  progress: null,
  message: '',
  step: '',
};

let registeredShortcut = null;
// The helper process watches physical press/release edges for push to talk.
// Modifier-only shortcuts also use it for toggle mode because RegisterHotKey
// cannot express those chords.
let chordWatch = null;
let chordWatchAccel = '';
let chordWatchRestartTimer = null;
let chordWatchRestartDelay = 250;
// True while the dictation chord is physically down from before the current
// watcher (or hotkey registration) existed. Changing the shortcut in settings
// registers the new chord on key-down, while the user's fingers are still on
// it; without this, keyboard auto-repeat or the watcher's first poll turned
// that lingering hold into a dictation of nothing, reported as "No speech".
let chordStaleHeld = false;
// Push to talk, tapped. A chord let go within this many milliseconds of going
// down was a tap, not a hold: keep recording and let the next press end it.
// The mic itself takes a couple of hundred milliseconds to open, so a hold
// this short could never have carried a word anyway.
const PTT_TAP_MS = 300;
// A hold the watcher and main.js time this far apart means the main thread was
// busy at one of its edges: logged, since a large enough gap once turned a
// real hold into a tap.
const PTT_LATE_EDGE_MS = 250;
let pttPressedAt = 0;
let pttLocked = false;
// The press that ends a locked dictation has a release of its own coming;
// that release must not be read as a second stop.
let pttIgnoreNextUp = false;
let registeredPasteShortcut = null;
let pasteLastBusy = false;
const backgroundMedia = createMediaController({
  // In a game, players still pause but the speakers are not muted: that would
  // take the game's own sound and the team on Discord with it.
  pause: async () => (await mediaCommand(gameDictation && process.platform === 'win32'
    ? ['media-pause', '-Mode', 'game'] : ['media-pause'])).split(/\r?\n/).map(s => s.trim()).filter(Boolean),
  resume: ids => mediaCommand(['media-resume', '-Ids', ids.join(',')]),
  onError: err => console.warn('Media control failed:', err.message),
});
let mediaShutdownDone = false;
let mediaPreparing = false;
let recordingSessionToken = 0;
function advanceRecordingSession() {
  return ++recordingSessionToken;
}
// A dictation that never leaves "arming" -- getUserMedia that hangs, a media
// pause whose helper never answers -- used to sit there until Escape. Long
// enough for a cold microphone on a slow machine; the renderer's own audio
// graph is up in well under a second when it comes up at all.
const ARMING_TIMEOUT_MS = 10000;
// Muting other audio for a recording waits until the flow bar says the start
// cue has been heard (start-cue-heard). This is the longest it waits for a
// bar that never says.
const START_CUE_MAX_WAIT_MS = 400;
let armingTimer = null;

function clearArmingTimer() {
  if (armingTimer) clearTimeout(armingTimer);
  armingTimer = null;
}

// --- Diagnostics -------------------------------------------------------------
// Written to data/flow-bar.log: the flow bar's page dying or going quiet,
// main's own loop stalling, a microphone that never opened, the machine
// waking up. Rare events, each one a line, so a "the bar froze" report comes
// with the record of what the app saw at the time. Created on first use,
// because the data directory is only known once the app is ready.
let diag = null;

function diagLog(event, fields) {
  if (!diag) {
    if (!DATA) return;
    diag = createDiagLog({ file: path.join(DATA, 'flow-bar.log') });
  }
  diag.log(event, fields);
}

function envInt(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

let ROOT;
let DATA;
let AUDIO;
let DICT_FILE;
let VOCAB_SEED;
let HIST_FILE;
let SETTINGS_FILE;
let NOTIFICATIONS_FILE;
let WIN32;
let HELPER;
let MODELS;
let ASR_RUNTIME;
let ASR_MODELS;
let CUDA_PACK;
let QWEN_CUDA_PACK;
let QWEN_ROCM_PACK;
let ICON_PNG;
let ICON_ICO;
let TRAY_PNG;

function resolveAssetIcon(name) {
  const asarPath = path.join(ROOT, 'assets', name);
  const unpacked = asarPath.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  if (unpacked !== asarPath && fs.existsSync(unpacked)) return unpacked;
  return asarPath;
}

function initPaths() {
  ROOT = path.join(__dirname, '..');
  if (app.isPackaged) {
    const res = process.resourcesPath;
    DATA = path.join(app.getPath('userData'), 'data');
    AUDIO = path.join(DATA, 'audio');
    DICT_FILE = path.join(DATA, 'dictionary.json');
    HIST_FILE = path.join(DATA, 'history.json');
    SETTINGS_FILE = path.join(DATA, 'settings.json');
    NOTIFICATIONS_FILE = path.join(DATA, 'notifications.json');
    VOCAB_SEED = path.join(res, 'scripts', 'vocabulary-seed.json');
    WIN32 = path.join(res, 'scripts', 'win32.ps1');
    HELPER = path.join(res, 'helper', 'voxden-helper');
    MODELS = path.join(app.getPath('userData'), 'models');
    ASR_RUNTIME = path.join(app.getPath('userData'), 'asr-runtime');
    ASR_MODELS = path.join(app.getPath('userData'), 'asr-models');
    CUDA_PACK = path.join(app.getPath('userData'), 'cuda-pack');
    QWEN_CUDA_PACK = path.join(app.getPath('userData'), 'qwen-cuda-pack');
    QWEN_ROCM_PACK = path.join(app.getPath('userData'), 'qwen-rocm-pack');
    ICON_PNG = resolveAssetIcon('icon.png');
    ICON_ICO = resolveAssetIcon('icon.ico');
    TRAY_PNG = resolveAssetIcon('tray-icon.png');
  } else {
    DATA = path.join(ROOT, 'data');
    AUDIO = path.join(DATA, 'audio');
    DICT_FILE = path.join(DATA, 'dictionary.json');
    VOCAB_SEED = path.join(ROOT, 'scripts', 'vocabulary-seed.json');
    HIST_FILE = path.join(DATA, 'history.json');
    SETTINGS_FILE = path.join(DATA, 'settings.json');
    NOTIFICATIONS_FILE = path.join(DATA, 'notifications.json');
    WIN32 = path.join(ROOT, 'scripts', 'win32.ps1');
    HELPER = path.join(ROOT, 'build', 'mac-helper', 'voxden-helper');
    MODELS = path.join(ROOT, 'models');
    ASR_RUNTIME = path.join(ROOT, 'models', 'asr-runtime');
    ASR_MODELS = path.join(ROOT, 'models', 'asr-models');
    CUDA_PACK = path.join(ROOT, 'models', 'cuda-pack');
    QWEN_CUDA_PACK = path.join(ROOT, 'models', 'qwen-cuda-pack');
    QWEN_ROCM_PACK = path.join(ROOT, 'models', 'qwen-rocm-pack');
    ICON_PNG = path.join(ROOT, 'assets', 'icon.png');
    ICON_ICO = path.join(ROOT, 'assets', 'icon.ico');
    TRAY_PNG = path.join(ROOT, 'assets', 'tray-icon.png');
  }
  vozModelManager = new VozModelManager({
    dataDir: DATA,
    onProgress: (state) => reportSetup('model', state),
  });
}

// An install that used to be Vell keeps its words: on first launch the
// small local files (settings, dictionary, history, notifications) are
// copied from the old Vell data folder when the Vell one has none yet.
// Model and runtime downloads stay where they are and are re-fetched only
// if missing.
function migrateLegacyData() {
  if (!DATA || process.env.VELL_SKIP_MIGRATION === '1') return;
  if (fs.existsSync(path.join(DATA, 'settings.json'))) return;
  let legacyBase = null;
  try {
    if (app.isPackaged) legacyBase = path.join(path.dirname(app.getPath('userData')), 'Voxden', 'data');
  } catch (_) { return; }
  if (!legacyBase || !fs.existsSync(legacyBase)) return;
  try {
    fs.mkdirSync(DATA, { recursive: true });
    for (const name of ['settings.json', 'dictionary.json', 'history.json', 'notifications.json']) {
      const from = path.join(legacyBase, name);
      const to = path.join(DATA, name);
      if (!fs.existsSync(to) && fs.existsSync(from)) fs.copyFileSync(from, to);
    }
  } catch (_) {}
}

function ensureData() {
  migrateLegacyData();
  fs.mkdirSync(DATA, { recursive: true });
  corpus.init(AUDIO);
  if (!fs.existsSync(DICT_FILE) && fs.existsSync(VOCAB_SEED)) {
    fs.copyFileSync(VOCAB_SEED, DICT_FILE);
  }
}

function appIconPath() {
  if (process.platform === 'win32' && ICON_ICO && fs.existsSync(ICON_ICO)) return ICON_ICO;
  if (ICON_PNG && fs.existsSync(ICON_PNG)) return ICON_PNG;
  if (ICON_ICO && fs.existsSync(ICON_ICO)) return ICON_ICO;
  return null;
}

function windowIconPath() {
  const src = appIconPath();
  if (!src) return null;
  if (process.platform !== 'win32') return src;
  try {
    const buf = fs.readFileSync(src);
    const hash = require('crypto').createHash('sha1').update(buf).digest('hex').slice(0, 12);
    const dest = path.join(os.tmpdir(), 'vell-icon-' + hash + path.extname(src));
    if (!fs.existsSync(dest)) fs.writeFileSync(dest, buf);
    return dest;
  } catch (_) {
    return src;
  }
}

function loadAppIconImage() {
  if (ICON_PNG && fs.existsSync(ICON_PNG)) {
    const png = nativeImage.createFromPath(ICON_PNG);
    if (png && !png.isEmpty()) return png;
  }
  const p = windowIconPath() || appIconPath();
  if (!p) return nativeImage.createEmpty();
  const img = nativeImage.createFromPath(p);
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

function applyWindowIcon(win) {
  if (!win || win.isDestroyed()) return;
  const p = windowIconPath();
  if (p) {
    try { win.setIcon(p); } catch (_) {}
  }
  const img = loadAppIconImage();
  if (!img.isEmpty()) {
    try { win.setIcon(img); } catch (_) {}
  }
}

function trayImage() {
  // macOS gets a dedicated monochrome glyph, not the full-color app icon. The
  // app icon is an opaque rounded square, so marking it as a template would
  // render a solid blob with the V lost; the tray asset is a transparent V
  // that macOS tints like the system icons around it.
  if (process.platform === 'darwin' && typeof TRAY_PNG === 'string' && TRAY_PNG) {
    try {
      if (fs.existsSync(TRAY_PNG)) {
        const glyph = nativeImage.createFromPath(TRAY_PNG);
        if (glyph && !glyph.isEmpty()) return macShell.menuBarImage(glyph, nativeImage);
      }
    } catch (_) {}
  }
  const img = loadAppIconImage();
  if (img.isEmpty()) return img;
  if (process.platform === 'darwin') return macShell.menuBarImage(img, nativeImage);
  const size = img.getSize();
  if (size.width <= 32 && size.height <= 32) return img;
  return img.resize({ width: 32, height: 32 });
}

// Which engine a downloaded component belongs to. There is only Voz.
function engineForComponent(id) {
  return String(id || '').trim().toLowerCase() === 'voz' ? 'voz' : '';
}

function loadSettings() {
  const defaults = {
    appTheme: 'voxden',
    dictateMode: 'toggle',
    shortcut: hotkeys.defaultShortcut(),
    pasteLastShortcut: 'CommandOrControl+Alt+V',
    gameShortcut: GAME_SHORTCUT_DEFAULT,
    gameShortcutEnabled: false,
    launchAtLogin: false,
    alwaysShowFlowBar: false,
    flowBarStyle: 'island',
    flowBarMotion: 'system',
    flowBarAnchor: null,
    showInTaskbar: false,
    soundsEnabled: true,
    suggestionsEnabled: true,
    autoAddToDictionary: true,
    keepTrainingAudio: false,
    keepRecordings: false,
    modelUnloadMinutes: 15,
    asrEngine: asr.DEFAULT_ASR_ENGINE,
    localModelChosen: false,
    asrDevice: 'auto',
    dictationLanguage: 'en',
    dictationLanguages: ['en'],
    microphone: 'default',
    displayName: '',
    displayNameFrom: '',
    muteMusicWhileDictating: true,
    writingStyles: Object.assign({}, style.DEFAULT_WRITING_STYLES),
    verbatimMode: false,
    verbatimDictionary: false,
    numbersAsDigits: true,
    autoCleanup: false,
    spokenCorrections: false,
  };
  let migratedEngine = false;
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (raw && typeof raw === 'object') {
      settings = Object.assign({}, defaults, raw);
      // Existing users keep their selection; new installs explicitly persist false.
      settings.localModelChosen = typeof raw.localModelChosen === 'boolean'
        ? raw.localModelChosen : !!raw.asrEngine;
      if (settings.dictateMode !== 'ptt' && settings.dictateMode !== 'toggle') {
        settings.dictateMode = 'toggle';
      }
      if (typeof settings.gameShortcut !== 'string') settings.gameShortcut = defaults.gameShortcut;
      // 2.1.7 took the game key for everyone, and a key Vell takes stops
      // working in every other app. It is off until the user turns it on,
      // including for the files 2.1.7 wrote, which have no such switch.
      if (typeof settings.gameShortcutEnabled !== 'boolean') settings.gameShortcutEnabled = false;
      if (!settings.shortcut || typeof settings.shortcut !== 'string') {
        settings.shortcut = defaults.shortcut;
      }
      if (!settings.pasteLastShortcut || typeof settings.pasteLastShortcut !== 'string') {
        settings.pasteLastShortcut = defaults.pasteLastShortcut;
      }
      // The list is the setting; the scalar is its first entry, kept for
      // files and readers from before there was a list.
      settings.dictationLanguages = asr.normalizeDictationLanguages(
        raw.dictationLanguages !== undefined ? raw.dictationLanguages : raw.dictationLanguage);
      settings.dictationLanguage = settings.dictationLanguages[0];
      if (raw.asrEngine === undefined || settings.asrEngine !== 'voz') {
        // One engine now: an old file names whatever the picker used to
        // offer. Point it at Voz without rewriting the user's file here; the
        // save below persists it once.
        settings.asrEngine = 'voz';
        migratedEngine = true;
      }
      settings.asrEngine = 'voz';
      settings.asrDevice = 'cpu';
      // The old per-engine models are gone with the sidecar; a settings file
      // from before still carries their keys.
      delete settings.smartRewriteEndpoint;
      delete settings.smartRewriteModel;
      delete settings.smartRewriteEnabled;
      delete settings.languagePack;
      delete settings.selectedTextRewrite;
      delete settings.contextAwareness;
      settings.writingStyles = style.normalizeWritingStyles(settings.writingStyles);
      delete settings.dictationQuality;
      settings.verbatimMode = !!settings.verbatimMode;
      settings.verbatimDictionary = !!settings.verbatimDictionary;
      settings.numbersAsDigits = settings.numbersAsDigits !== false;
      settings.autoCleanup = settings.autoCleanup === true;
      settings.keepRecordings = settings.keepRecordings === true;
      settings.modelUnloadMinutes = normalizeModelUnloadMinutes(
        raw.modelUnloadMinutes !== undefined ? raw.modelUnloadMinutes : settings.modelUnloadMinutes);
      // The hosted plan is gone: an old file may still carry the switch.
      delete settings.cloudTranscription;
      settings.autoAddToDictionary = settings.autoAddToDictionary !== false;
      settings.flowBarAnchor = flowBar.normalizeAnchor(settings.flowBarAnchor);
      settings.flowBarStyle = flowBar.normalizeStyle(settings.flowBarStyle);
      settings.flowBarMotion = normalizeFlowMotion(settings.flowBarMotion);
      settings.appTheme = appTheme.normalize(settings.appTheme);
      // Retire old automatic-send preferences so they cannot submit a draft.
      delete settings.autoSend;
      // The sidebar it folded was replaced by the Island header in 2.2.0.
      delete settings.sidebarCollapsed;
    } else {
      settings = defaults;
    }
  } catch (_) {
    settings = defaults;
  }
  const languagesChanged = syncDictationLanguages();
  if (migratedEngine || languagesChanged) {
    try { saveSettings(); } catch (_) {}
  }
}

const formatShortcutLabel = hotkeys.formatShortcutLabel;
const trayMenuLabel = hotkeys.trayMenuLabel;

// Minutes of dictation inactivity before the Voz model is dropped from RAM.
// 0 means never unload. Clamped to whole minutes, max 4h, default 15.
function normalizeModelUnloadMinutes(value) {
  if (value === 0 || value === '0') return 0;
  if (value === null || value === undefined || value === '') return 15;
  const n = Number(value);
  if (!Number.isFinite(n)) return 15;
  if (n <= 0) return 0;
  return Math.min(240, Math.max(1, Math.round(n)));
}

function applySystemSettings() {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!settings.launchAtLogin,
      args: ['--hidden'],
      openAsHidden: true,
    });
  } catch (_) {}
  if (historyWin && !historyWin.isDestroyed()) {
    try {
      if (settings.showInTaskbar) historyWin.setSkipTaskbar(false);
      else if (!historyWin.isVisible()) historyWin.setSkipTaskbar(true);
    } catch (_) {}
  }
  if (restingBarWanted()) {
    showOverlay();
    // Preference updates must not replay an active capture or result. Idle
    // still needs its state so the renderer can reveal the resting bar.
    sendOverlay({ mode: mode === 'idle' ? 'idle' : undefined, reveal: true });
  }
}

function saveSettings() {
  ensureData();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function isPtt() {
  return settings.dictateMode === 'ptt' && chordWatchSupported();
}

function loadStores() {
  ensureData();
  dictionary = dict.load(DICT_FILE);
  // Usage counters and provenance timestamps live in the same file under a
  // separate key; dict.load ignores them, so they are read here and folded in.
  // A file written by an older build simply has none, and every entry starts
  // from its dictionary position instead.
  storedVocabularyEntries = readStoredEntries(DICT_FILE);
  vocabularyDirty = true;
  loadSettings();
  loadNotifications();
  dropOldAdminAppNotes();
  history = historyStore.load(HIST_FILE);
  historyAnalyticsRevision += 1;
  historyUsage.invalidate();
}

function loadNotifications() {
  try {
    notifications = announcements.normalizeState(JSON.parse(fs.readFileSync(NOTIFICATIONS_FILE, 'utf8')));
  } catch (_) {
    // No file yet is the fresh-install case, and announcements treats an empty
    // store as one: the user is told what shipped in this build and nothing
    // about the releases before it.
    notifications = announcements.normalizeState(null);
  }
}

function saveNotifications() {
  ensureData();
  fs.writeFileSync(NOTIFICATIONS_FILE, JSON.stringify(notifications, null, 2));
}

// 2.1.7 noted every app run as administrator that came to the front, Task
// Manager and the Windows sign-in prompt among them. Those notes are dropped
// once -- removed, not cleared, since a cleared id is never noted again -- so
// an app that still earns one under the rules that replaced them (a game run
// as administrator, a refused paste) gets it back.
function dropOldAdminAppNotes() {
  if (settings.adminAppNotesReset === true) return;
  const next = announcements.normalizeState(notifications);
  let dropped = 0;
  for (const id of Object.keys(next.items)) {
    if (!id.startsWith('admin-app:')) continue;
    delete next.items[id];
    dropped++;
  }
  settings.adminAppNotesReset = true;
  try { saveSettings(); } catch (_) {}
  if (!dropped) return;
  notifications = next;
  try { saveNotifications(); } catch (_) {}
}

// Apply a result from announcements: persist only when something moved, and
// let the window know only when it did.
function applyNotifications(result, options) {
  if (!result || !result.changed) return false;
  notifications = result.state;
  try { saveNotifications(); } catch (_) {}
  if (!options || options.broadcast !== false) broadcast();
  return true;
}

function deliverAnnouncements() {
  applyNotifications(
    announcements.deliver(notifications, { version: app.getVersion() }),
    { broadcast: false },
  );
}

// Whether this Vell runs as administrator: true or false once the Win32
// helper has said (checkElevation), null before that, and on a Mac.
let runningAsAdmin = null;
let elevationCheck = null;

function checkElevation() {
  if (process.platform !== 'win32') return Promise.resolve();
  if (!elevationCheck) {
    elevationCheck = ps(['elevated'])
      .then((out) => { if (out === '1' || out === '0') runningAsAdmin = out === '1'; })
      .catch(() => {})
      .then(() => {
        elevationCheck = null;
        broadcast();
      });
  }
  return elevationCheck;
}

// An app run as administrator -- some games are -- is out of reach of a
// Vell that is not: while it is in front, Windows passes Vell none of its
// shortcuts and drops every key Vell sends it (measured 2026-10-02). A
// dictation into it is left on the clipboard instead, and the flow bar says so
// for under two seconds, often unseen over a fullscreen game. The bell keeps
// the why and the lasting fix, once per app: one note, whether the app was
// first seen in front (noteAdminForeground) or first refused a paste.
const ADMIN_PASTE_FLASH = 'Runs as admin: press Ctrl+V to paste';
// The same for a paste refused because a fullscreen game or film went in
// front of the window the words were for (win32.ps1, paste).
const FULLSCREEN_PASTE_FLASH = 'Fullscreen app in front: press Ctrl+V to paste';
function noteAdminApp(exe) {
  // Elevated, Vell reaches these apps, and the fix is where it already is.
  if (runningAsAdmin === true) return;
  const name = String(exe || '').trim() || 'This app';
  applyNotifications(announcements.note(notifications, {
    id: 'admin-app:' + name.toLowerCase(),
    kind: 'paste',
    title: name + ' runs as administrator',
    body: 'Windows does not let Vell hear its shortcuts or type into it while it is in front, '
      + 'so a dictation into it waits on the clipboard for your Ctrl+V. '
      + 'To dictate into it as usual, open Settings, System, and choose Restart as administrator.',
    action: { settings: 'system' },
  }));
}

// --- the free plan's weekly words -------------------------------------------
function saveHistory(next = history) {
  ensureData();
  // Retained transcripts and archived statistics commit as one document.
  // Failed writes leave the previous in-memory history and its audio intact.
  history = historyStore.save(HIST_FILE, next);
  historyAnalyticsRevision += 1;
  historyUsage.invalidate();
}

function saveDict() {
  // The structured view is written back alongside the legacy keys so usage and
  // provenance survive a restart. Rebuilt first, so what is persisted is what
  // the next dictation will use -- an edit takes effect on the very next
  // utterance, with no restart and no cache to go stale.
  vocabularyDirty = true;
  const entries = currentVocabulary();
  vocabulary.saveState(DICT_FILE, {
    phrases: dictionary.phrases,
    variants: dictionary.variants,
    pending: dictionary.pending,
    blocked: dictionary.blocked,
    entries,
  });
  storedVocabularyEntries = entries;
  historyAnalyticsRevision += 1;
  historyUsage.invalidate();
}

let storedVocabularyEntries = [];

function readStoredEntries(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(raw.entries) ? raw.entries : [];
  } catch (_) {
    return [];
  }
}

// The ranked vocabulary for right now. Cheap enough to rebuild on demand --
// the dictionaries in the wild are in the low hundreds of terms -- and only
// rebuilt when something actually changed.
function currentVocabulary() {
  if (vocabularyDirty) {
    vocabularyEntries = vocabulary.fromDictionary(dictionary, storedVocabularyEntries);
    vocabularyDirty = false;
  }
  return vocabularyEntries;
}

// The terms offered to a dictation, in the order they deserve the budget.
// Language filtering happens here: a Devanagari term has no business in the
// Local-only: there is no plan and no cloud; the picker always offers every
// Voz language.
function dictationPolicy() {
  return { plan: 'free', cloud: false };
}

function syncDictationLanguages(list) {
  const source = list !== undefined ? list : (settings.dictationLanguages || settings.dictationLanguage);
  const next = asr.constrainDictationLanguages(source, dictationPolicy());
  const prev = Array.isArray(settings.dictationLanguages) ? settings.dictationLanguages.join(',') : '';
  settings.dictationLanguages = next;
  settings.dictationLanguage = next[0];
  return prev !== next.join(',');
}

function dictationLanguages() {
  const list = asr.normalizeDictationLanguages(settings.dictationLanguages || settings.dictationLanguage);
  // The scalar set on its own, by code that predates the list, wins: it is
  // the only way that code has to say what it means.
  const scalar = String(settings.dictationLanguage || '').trim().toLowerCase();
  if (scalar && asr.DICTATION_LANGUAGE_IDS.includes(scalar) && scalar !== list[0]) return [scalar];
  return list;
}

// The language the text rules run in: commands, numbers, tone, the
// dictionary. English wins whenever it is on the list, because a mixed
// dictation is an English sentence with other words in it. Otherwise the
// first selected language is what the transcript is treated as.
function textLanguage() {
  const list = dictationLanguages();
  if (list.includes('en')) return 'en';
  return asr.engineLanguageId(list[0]);
}

// The language the engine is told. Voz takes no language input, so this is
// the language the text rules run in.
function engineLanguage() {
  return textLanguage();
}

function vocabularyForDictation(language) {
  return vocabulary.rank(currentVocabulary(), {
    language: language || textLanguage(),
    recentTerms: vocabulary.recentTermSet(history.entries, 40),
  });
}

// Spoken corrections are still being worked on, so a release leaves them out:
// no switch in Settings, nothing applied, nothing sent, whatever a settings
// file says. A development build (npm start) has them, and so does a packaged
// one started with VOXDEN_SPOKEN_CORRECTIONS=1.
function spokenCorrectionsAvailable() {
  return !app.isPackaged || process.env.VOXDEN_SPOKEN_CORRECTIONS === '1';
}

function snapshot() {
  const usageStats = historyUsage.getStats(history, historyAnalyticsRevision);
  const wordCount = usageStats.wordCount;
  const understanding = dict.understandingState(wordCount);
  const notificationList = announcements.list(notifications);
  return {
    entries: entriesWithAudio(),
    analyticsRevision: historyAnalyticsRevision,
    usageStats,
    phrases: dictionary.phrases,
    pendingPhrases: dictionary.pending || [],
    variantCount: (dictionary.variants || []).length,
    engine: 'voz',
    engineStatus: vozModelManager && vozModelManager.installed() ? 'ready' : 'missing',
    model: 'Voz',
    device: 'cpu',
    // Voz is the only engine, running in-process on the CPU.
    asrEngine: 'voz',
    asrDevice: 'cpu',
    asrEngineActive: 'voz',
    asrEngineWarning: '',
    asrEngineFix: '',
    asrEngineFixEngine: '',
    asrEngineAvailable: { voz: true },
    usingManagedRuntime: false,
    asrEngineError: engineError,
    // No separate runtime to download: Electron plus onnxruntime-node is the
    // runtime, and it ships inside the app.
    asrRuntime: { installed: true },
    // The Voz model is the only model. It keeps the asrModel shape so the
    // settings rows and the banner keep working unchanged.
    asrModel: vozModelManager ? vozModelManager.snapshot() : null,
    speechModels: { packs: [], installed: true, downloadBytes: 0 },
    // What this configuration needs, what it is offered, and what each costs.
    // The renderer shows the required figure rather than the sum of everything
    // that exists, because the sum was never what anybody had to download.
    modelPlan: vozModelManager ? currentModelPlan() : null,
    asrOperation: asrOperation ? asrOperation.kind : null,
    asrRuntimeState,
    asrRuntimeWouldHelp: asrRuntimeWouldHelp(),
    localModelChosen: settings.localModelChosen === true,
    asrEngineProgress: engineProgress,
    fastEngine: null,
    gpu: null,
    // Which OS this is, and which engines it offers. The renderer draws the
    // model chooser from these two rather than from a hardcoded list, so an
    // engine that cannot run here is never on screen to be picked.
    platform: process.platform,
    availableEngines: modelPlan.availableEngines(process.platform),
    cudaPack: null,
    cudaPackState: null,
    qwenAccel: null,
    qwenCudaPack: null,
    qwenCudaPackState: null,
    qwenRocmPack: null,
    qwenRocmPackState: null,
    asrFastOnCpu: false,
    fastModel: null,
    fastDevice: null,
    // What the dictionary can actually do on the engine that is running.
    // Voz takes no vocabulary input, so terms are applied after recognition.
    vocabularyMechanism: 'repair',
    fastVocabularyMechanism: 'repair',
    vocabularyBudget: capabilities.vocabularyBudget('voz'),
    vocabularyTerms: currentVocabulary().length,
    lastDictationVocabulary: lastVocabularyReport,
    dictateMode: settings.dictateMode,
    gameShortcut: settings.gameShortcut,
    gameShortcutLabel: formatShortcutLabel(settings.gameShortcut),
    gameShortcutEnabled: settings.gameShortcutEnabled === true,
    // Settings > System offers Restart as administrator only while this is false.
    runningAsAdmin: runningAsAdmin === true,
    shortcut: settings.shortcut,
    shortcutLabel: formatShortcutLabel(settings.shortcut),
    pasteLastShortcut: settings.pasteLastShortcut,
    pasteLastShortcutLabel: formatShortcutLabel(settings.pasteLastShortcut),
    hotkeyNotice,
    appTheme: appTheme.normalize(settings.appTheme),
    launchAtLogin: settings.launchAtLogin,
    alwaysShowFlowBar: settings.alwaysShowFlowBar,
    flowBarStyle: settings.flowBarStyle,
    flowBarMotion: settings.flowBarMotion,
    flowBarMoved: !!settings.flowBarAnchor,
    showInTaskbar: settings.showInTaskbar,
    soundsEnabled: settings.soundsEnabled,
    suggestionsEnabled: settings.suggestionsEnabled,
    autoAddToDictionary: settings.autoAddToDictionary !== false,
    keepTrainingAudio: !!settings.keepTrainingAudio,
    keepRecordings: settings.keepRecordings !== false,
    modelUnloadMinutes: normalizeModelUnloadMinutes(settings.modelUnloadMinutes),
    modelLoaded: vozLoaded === true,
    recordingsError,
    trainingError,
    recordings: corpus.recordingStats(),
    recoveries: recoveryList(),
    training: corpus.stats(),
    useTunedModel: false,
    tunedModel: null,
    modelIsTuned: false,
    dictationLanguage: textLanguage(),
    dictationLanguages: dictationLanguages(),
    dictationLanguageUnlocked: asr.dictationLanguageUnlocked(dictationPolicy()),
    dictationLanguageMax: asr.dictationLanguageLimit(dictationPolicy()),
    dictationLanguageOffered: asr.offeredDictationLanguages(dictationPolicy()),
    dictationLanguageCatalog: asr.DICTATION_LANGUAGES,
    microphone: settings.microphone,
    displayName: settings.displayName || '',
    muteMusicWhileDictating: settings.muteMusicWhileDictating !== false,
    writingStyles: style.normalizeWritingStyles(settings.writingStyles),

    verbatimMode: !!settings.verbatimMode,
    verbatimDictionary: !!settings.verbatimDictionary,
    numbersAsDigits: settings.numbersAsDigits !== false,
    autoCleanup: settings.autoCleanup === true,
    spokenCorrections: settings.spokenCorrections === true,
    // Whether Settings shows the switch at all (spokenCorrectionsAvailable).
    spokenCorrectionsAvailable: spokenCorrectionsAvailable(),
    canRetry: keepingClips() && corpus.hasRetry(),
    notifications: notificationList,
    notificationsUnread: announcements.unreadCount(notificationList),
    wordCount,
    ...understanding,
  };
}

function refreshHistoryWindow() {
  if (!historySnapshotPending || !historyWin || historyWin.isDestroyed()) return;
  if (typeof historyWin.isVisible === 'function' && !historyWin.isVisible()) return;
  if (typeof historyWin.isMinimized === 'function' && historyWin.isMinimized()) return;
  try {
    historyWin.webContents.send('history-updated', snapshot());
    historySnapshotPending = false;
  } catch (err) {
    try { fs.appendFileSync(path.join(DATA || os.tmpdir(), 'sidecar.log'), String(err && err.stack || err) + '\n'); } catch (_) {}
  }
}

function broadcast() {
  // The dashboard normally lives hidden in the tray while the user dictates.
  // Avoid scanning and cloning its full history for every background update;
  // show/restore delivers one fresh snapshot containing all intervening changes.
  historySnapshotPending = true;
  refreshHistoryWindow();
  // The tray menu shows the same settings and the same history, so it goes
  // stale on exactly the events that refresh the window.
  refreshTray();
}

let lastAsrProgressKey = '';

function asrProgressIsWorthSending(state) {
  if (state.status !== 'downloading' && state.status !== 'installing') {
    lastAsrProgressKey = '';
    return true;
  }
  const percent = Number.isFinite(state.progress) ? Math.floor(state.progress) : -1;
  const key = state.step + ':' + state.status + ':' + percent;
  if (key === lastAsrProgressKey) return false;
  lastAsrProgressKey = key;
  return true;
}

// Weight setup progress by the model bytes still needed, including Qwen and Parakeet.
let setupWeights = { engine: 0.05, model: 0.27, extras: 0.68 };

function reportSetup(step, state) {
  const before = step === 'model' ? setupWeights.engine
    : step === 'extras' ? setupWeights.engine + setupWeights.model : 0;
  const own = Number.isFinite(state.progress) ? Math.max(0, Math.min(100, state.progress)) : 0;
  // An individual component completing is still part of the same busy operation.
  const status = state.status === 'installed' ? 'installing' : state.status;
  asrRuntimeState = { ...state, status, step,
    progress: Math.floor(100 * before + (setupWeights[step] || 0) * own) };
  if (asrProgressIsWorthSending(asrRuntimeState)) broadcast();
}

function asrDisabledPath() { return path.join(ASR_RUNTIME, 'disabled.json'); }
function asrIsDisabled() { return fs.existsSync(asrDisabledPath()); }

function runAsrOperation(kind, work) {
  // Share the result across every caller, including the banner and settings.
  // Never let a second click overwrite the first operation's progress/error.
  if (asrOperation) return asrOperation.promise;
  const operation = { kind, promise: null };
  asrOperation = operation;
  operation.promise = Promise.resolve().then(async () => {
    return work();
  }).finally(() => {
    asrOperation = null;
    asrSetupController = null;
    broadcast();
  }).then(() => snapshot());
  return operation.promise;
}

// What this PC needs for the engine it is set to, and what is merely being
// offered. One call, so the banner, the settings panel and the downloader
// cannot disagree about the size of the download.
function currentModelPlan(overrides) {
  const opts = overrides || {};
  const voz = vozModelManager ? vozModelManager.snapshot() : { installed: false, downloadBytes: 0 };
  const sizes = { voz: voz.downloadBytes || 0 };
  const installed = { voz: !!voz.installed };
  return modelPlan.plan({
    // The engine this build will honour, so the download the banner names is
    // the one transcription actually needs.
    engine: effectiveEngine(opts.engine || settings.asrEngine),
    device: 'cpu',
    language: opts.language || textLanguage(),
    sizes,
    installed,
  });
}

// Install exactly the components named, or the ones the current settings
// require when nothing is named. There is one component: the Voz model,
// fetched and cached by its own provider.
async function setupDictation(signal, options) {
  const opts = options || {};
  const plan = currentModelPlan();
  const wanted = opts.components && opts.components.length
    ? opts.components.filter((id) => id === 'voz')
    : plan.missing;
  const vozBytes = wanted.includes('voz') && vozModelManager && !vozModelManager.installed()
    ? vozModelManager.snapshot().downloadBytes : 0;
  const total = vozBytes || 1;
  setupWeights = { engine: 0, model: vozBytes / total, extras: 0 };
  const names = wanted.map((id) => (modelPlan.COMPONENTS[id] || {}).name || id);
  asrRuntimeState = {
    status: 'preparing',
    progress: 0,
    message: names.length ? 'Preparing ' + names.join(' and ') + '…' : 'Preparing dictation…',
    step: 'model',
  };
  saveAsrSetupState();
  broadcast();
  await fs.promises.mkdir(DATA, { recursive: true });
  const disk = await fs.promises.statfs(DATA);
  const required = vozBytes + 512e6;
  if (disk.bavail * disk.bsize < required) {
    throw new Error('Speech setup needs about ' + Math.ceil(required / 1e9)
      + ' GB of free disk space. Free some space and try again.');
  }
  await cancelListen();
  const checkCancelled = () => {
    if (signal.aborted) throw Object.assign(new Error('Setup cancelled. Download again to resume.'), { code: 'CANCELLED' });
  };
  checkCancelled();
  if (wanted.includes('voz') && vozModelManager) {
    await vozModelManager.install({
      onProgress: (fraction) => reportSetup('model', { status: 'downloading', progress: Math.round(fraction * 100) }),
    });
    checkCancelled();
  }
  settings.localModelChosen = true;
  saveSettings();
  setSidecarState('ready');
  asrRuntimeState = {
    status: 'installed',
    progress: 100,
    message: (names.length ? names.join(' and ') + ' installed. ' : '') + 'Starting dictation…',
    step: 'done',
  };
}

function asrSetupStatePath() {
  return path.join(ASR_RUNTIME, 'setup-state.json');
}

// The setup state used to live only in memory, so quitting after a failed or
// cancelled download threw away the only record that it had ever been tried.
// Only a finished run is written -- progress is not worth a disk write per
// percent, and a run still going is already described by the live state.
// A success is written even though nothing reads it back: it is what
// overwrites an earlier failure note, so a retry that works stops the banner
// re-accusing the app on every launch that follows.
function saveAsrSetupState() {
  const status = asrRuntimeState.status;
  if (!['preparing', 'error', 'cancelled', 'installed', 'removed'].includes(status)) return;
  try {
    fs.mkdirSync(ASR_RUNTIME, { recursive: true });
    fs.writeFileSync(asrSetupStatePath(), JSON.stringify({
      status,
      message: String(asrRuntimeState.message || ''),
      step: String(asrRuntimeState.step || ''),
    }));
  } catch (_) {}
}

// Finish what an earlier run could not, and drop what it never should have
// kept. A removal the app quit in the middle of, or that a locked file cut
// short, left its tree set aside under a .removing- name; those go now. And
// setup in older versions copied models out of the cache into the managed
// store and left the originals, which is how a PC ended up holding every
// model twice: once the managed copies are what the engine loads, the cached
// ones go too. A developer build without the managed runtime still reads the
// cache, so it keeps it. Not awaited: none of this is needed to dictate.
function tidyModelStorage() {
  const roots = [
    ASR_RUNTIME, ASR_MODELS, path.join(ASR_MODELS, 'extras'),
    CUDA_PACK, QWEN_CUDA_PACK, QWEN_ROCM_PACK,
    MODELS, path.join(MODELS, '.locks'),
    path.join(MODELS, 'huggingface', 'hub'), path.join(MODELS, 'huggingface', 'hub', '.locks'),
  ];
  return (async () => {
    for (const root of roots) await cleanRemove.sweepRemoved(root);
    // Local sentence correction is gone. A PC that downloaded a language pack
    // before then still holds up to 2.5 GB of model and runtime under
    // models/writer that nothing will ever load again, plus its log.
    await cleanRemove.removeTree(path.join(MODELS, 'writer')).catch(() => {});
    await fs.promises.rm(path.join(DATA, 'local-correction.log'), { force: true }).catch(() => {});
    // The Python sidecar and everything it ran on -- runtimes, model packs,
    // GPU packs, the Hub cache -- are gone: Voz runs in-process. Remove their
    // trees outright so a previous install's gigabytes do not linger. The Voz
    // bundle itself lives in the OS cache and is managed by its own provider.
    for (const root of [ASR_RUNTIME, ASR_MODELS, CUDA_PACK, QWEN_CUDA_PACK, QWEN_ROCM_PACK,
        path.join(MODELS, 'extras'),
        path.join(MODELS, 'huggingface')]) {
      await cleanRemove.removeTree(root).catch(() => {});
    }
  })().catch(err => console.error('model storage tidy failed:', err && err.message ? err.message : err));
}

// Restores an interrupted setup so the banner can explain itself on the next
// launch rather than starting over silent. The receipts on disk outrank the
// file: if both halves are present now the run finished, however it ended.
function loadAsrSetupState() {
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(asrSetupStatePath(), 'utf8'));
  } catch (_) {
    return;
  }
  if (!saved || typeof saved !== 'object') return;
  if (!['preparing', 'error', 'cancelled'].includes(saved.status)) return;
  if (vozModelManager && vozModelManager.installed() && currentModelPlan().ready) return;
  asrRuntimeState = {
    status: saved.status === 'preparing' ? 'cancelled' : saved.status,
    progress: null,
    message: saved.status === 'preparing' ? 'Setup was interrupted. Download again to resume.'
      : String(saved.message || 'Dictation setup did not finish.'),
    step: String(saved.step || 'engine'),
  };
}

function nid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// --- Win32 helper ------------------------------------------------------------
// Every call used to be a fresh powershell.exe that compiled the helper class
// before doing anything: a quarter of a CPU second and most of a wall second,
// and a dictation made four or five of them. The paste alone put the text on
// screen a full second after the engine had finished with it. The helper now
// runs as a small pool of long-lived servers speaking JSON over stdin/stdout,
// compiled once each. A call that finds every server busy still gets the old
// one-shot process, so nothing ever waits behind somebody else's request.
// The platform helper: win32.ps1 through PowerShell on Windows, the compiled
// Swift helper (helper/mac/main.swift) on macOS. Both take the same arguments
// and speak the same serve protocol, so the call sites below differ only here.
function helperCommand(args) {
  if (process.platform === 'darwin') return { file: HELPER, args: [...args] };
  return { file: elevation.powershellPath(), args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WIN32, ...args] };
}

const PS_SERVER_POOL = 2;
const PS_SERVER_IDLE_MS = 90000;
const PS_SERVER_START_MS = 15000;

let psServers = [];
let psServersAllowed = true;
let psRequestId = 0;

function psParseArgs(args) {
  const list = Array.isArray(args) ? args.map((a) => String(a)) : [];
  if (!list.length || list[0].startsWith('-')) return null;
  const req = { action: list[0] };
  for (let i = 1; i < list.length; i += 2) {
    const name = list[i];
    if (!name.startsWith('-') || i + 1 >= list.length) return null;
    req[name.slice(1).toLowerCase()] = list[i + 1];
  }
  return req;
}

function psOneShot(args, timeoutMs) {
  const cmd = helperCommand(args);
  return new Promise((resolve) => {
    execFile(
      cmd.file,
      cmd.args,
      { windowsHide: true, timeout: Number(timeoutMs) || 4000 },
      (err, stdout) => {
        if (err && args[0] !== 'media-pause') return resolve('');
        resolve(String(stdout || '').trim());
      }
    );
  });
}

function psRetireServer(server, reason) {
  if (server.retired) return;
  server.retired = true;
  psServers = psServers.filter((s) => s !== server);
  if (server.idleTimer) clearTimeout(server.idleTimer);
  if (server.startTimer) clearTimeout(server.startTimer);
  const pending = server.pending;
  server.pending = null;
  try { server.proc.stdin.write('QUIT\n'); } catch (_) {}
  try { server.proc.kill(); } catch (_) {}
  if (pending) pending.fail(reason || 'helper gone');
}

function psScheduleIdle(server) {
  if (server.idleTimer) clearTimeout(server.idleTimer);
  // One server stays warm so the next paste is instant; extras go away.
  server.idleTimer = setTimeout(() => {
    server.idleTimer = null;
    if (server.pending) return;
    const idle = psServers.filter((s) => !s.pending && s.ready);
    if (idle.length > 1) psRetireServer(server, 'idle');
  }, PS_SERVER_IDLE_MS);
}

function psLaunchServer() {
  if (!psServersAllowed || isQuitting || psServers.length >= PS_SERVER_POOL) return null;
  let proc;
  const cmd = helperCommand(['-Action', 'serve']);
  try {
    proc = spawn(cmd.file, cmd.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (_) {
    return null;
  }
  const server = { proc, pending: null, ready: false, buf: '', idleTimer: null, startTimer: null };
  psServers.push(server);
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    server.buf += chunk;
    let idx;
    while ((idx = server.buf.indexOf('\n')) >= 0) {
      const line = server.buf.slice(0, idx).trim();
      server.buf = server.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      if (!server.ready) {
        server.ready = true;
        if (server.startTimer) clearTimeout(server.startTimer);
        server.startTimer = null;
      }
      const pending = server.pending;
      if (pending && String(msg.id) === pending.id) {
        if (msg.partial) {
          pending.receipts.push(String(msg.out || ''));
          continue;
        }
        server.pending = null;
        pending.done([...pending.receipts, String(msg.out || '')].filter(Boolean).join('\n'));
        psScheduleIdle(server);
      }
    }
  });
  proc.stderr.on('data', () => {});
  const lost = () => psRetireServer(server, 'exited');
  proc.on('error', lost);
  proc.on('exit', lost);
  // A write to a helper that has already gone (QUIT at shutdown, a request
  // racing its exit) fails as an 'error' event on stdin, not a throw. Unheard,
  // it is an uncaught exception in main; the release CI hit it while quitting.
  proc.stdin.on('error', lost);
  // A hello so the caller knows the class has compiled, and a deadline on it:
  // a PowerShell that cannot get this far is a PowerShell not worth waiting
  // on, and callers fall back to one-shot processes from then on.
  server.startTimer = setTimeout(() => {
    server.startTimer = null;
    if (!server.ready) {
      psRetireServer(server, 'start timeout');
      if (!psServers.length) psServersAllowed = false;
    }
  }, PS_SERVER_START_MS);
  psSend(server, { id: 'hello', action: 'get' }, 'hello');
  return server;
}

function psSend(server, req, id) {
  const line = JSON.stringify(Object.assign({}, req, { id }));
  try {
    server.proc.stdin.write(line + '\n');
    return true;
  } catch (_) {
    psRetireServer(server, 'write failed');
    return false;
  }
}

function warmPsServers() {
  if (!psServers.length) psLaunchServer();
}

function stopPsServers() {
  psServersAllowed = false;
  for (const server of psServers.slice()) psRetireServer(server, 'quit');
}

function ps(args, timeoutMs) {
  const req = psParseArgs(args);
  const timeout = Number(timeoutMs) || 4000;
  // select-back is keys into a window at the moment of asking; a one-shot
  // PowerShell starts a second or more later, so without a server it simply
  // does not happen and the polished words go to the clipboard instead.
  const oneShot = () => (req && req.action === 'select-back' ? Promise.resolve('') : psOneShot(args, timeoutMs));
  if (!req || !psServersAllowed || isQuitting) return oneShot();
  let server = psServers.find((s) => s.ready && !s.pending);
  if (!server) {
    // Nothing idle: grow the pool if there is room, otherwise do not queue
    // behind whatever the busy server is doing.
    const starting = psServers.find((s) => !s.ready && !s.pending);
    server = starting || psLaunchServer();
    if (!server) return oneShot();
  }
  return new Promise((resolve) => {
    const id = String(++psRequestId);
    let settled = false;
    let timer = null;
    const finish = (out) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(String(out || '').trim());
    };
    server.pending = {
      id,
      receipts: [],
      done: finish,
      fail: function () { finish(this.receipts.join('\n')); },
    };
    if (server.idleTimer) clearTimeout(server.idleTimer);
    timer = setTimeout(() => {
      // A stuck helper is replaced, not waited for. The reply, if it ever
      // comes, has nobody to go to.
      psRetireServer(server, 'timeout');
      finish('');
    }, timeout + (server.ready ? 0 : PS_SERVER_START_MS));
    if (!psSend(server, req, id)) finish('');
  });
}

// Transcription runs in-process through onnxruntime-node: there is no
// interpreter to find and no sidecar to launch. Readiness is the model.

// Whether the Set up button has something to fix: the Voz model is missing,
// or a setup run failed or was cancelled halfway.
function asrRuntimeWouldHelp() {
  if (!vozModelManager) return false;
  return !vozModelManager.installed();
}

function sendOverlay(extra) {
  // Cheap: the signature check exits before building anything unless the
  // dictation actually started or finished.
  refreshTray();
  // The grip only exists next to the resting bar, but a hotkey can start a
  // dictation with the button still down. Put the bar down where it is rather
  // than let the recording pill carry on following the cursor.
  if (extra && extra.mode && extra.mode !== 'idle') stopOverlayDrag(true);
  if (extra && extra.mode === 'idle') {
    overlayEditing = false;
    if (overlayWin && !overlayWin.isDestroyed()) {
      // positionOverlay sets the size too, and it reads overlayEditing, which
      // the line above just cleared.
      try { positionOverlay(); } catch (_) {}
    }
  }
  if (!overlayWin || overlayWin.isDestroyed()) return;
  overlayWin.webContents.send('state', Object.assign({
    mode,
    prepareOnly: mediaPreparing,
    engine: 'voz',
    engineStatus: vozModelManager && vozModelManager.installed() ? 'ready' : 'missing',
    model: 'Voz',
    device: 'cpu',
    asrEngineActive: 'voz',
    fastEngine: null,
    dictateMode: settings.dictateMode,
    pttLocked,
    shortcut: settings.shortcut,
    shortcutLabel: formatShortcutLabel(settings.shortcut),
    // The page keeps the bar out at rest only when this is true.
    alwaysShowFlowBar: restingBarWanted(),
    flowBarStyle: settings.flowBarStyle,
    flowBarMotion: settings.flowBarMotion,
    soundsEnabled: settings.soundsEnabled,
    microphone: settings.microphone || 'default',
    canRetry: keepingClips() && corpus.hasRetry(),
    // Whether a long dictation should write itself to disk as it goes, so a
    // crash or a power cut does not take it with it. Off means the renderer
    // does no extra work at all.
    keepLiveAudio: keepingClips(),
  }, mode === 'learned' && autoLearnNotice ? autoLearnNotice : {}, extra || {}));
}

let overlayIgnoreMouse = null;
let overlayEditing = false;

function overlaySize() {
  // The window is bottom-anchored, so extra height is headroom above the pill.
  // It has to clear the tallest shape plus its glow, or the halo gets cut off.
  // The idle width holds the gear and grip beside the mic.
  if (mode === 'learned') return { ww: 460, wh: 96 };
  if (overlayEditing) return { ww: 380, wh: 110 };
  return { ww: 260, wh: 96 };
}

function overlaySizeRect() {
  const { ww, wh } = overlaySize();
  return { width: ww, height: wh };
}

// The saved anchor read through whatever monitors exist right now. A point
// left behind by a display that has since been unplugged resolves onto the
// nearest one that is still there, so the bar can never end up parked in dead
// space -- which is one of the ways it used to go missing.
function overlayAnchor(size) {
  return flowBar.resolveAnchor(
    settings.flowBarAnchor,
    screen.getAllDisplays(),
    screen.getPrimaryDisplay(),
    size || overlaySizeRect()
  );
}

// Sets the whole rect, never just the corner. setPosition() re-sends the size
// it reads back from the window, and that read-back does not survive a scaled
// display: at 125% a 260x84 overlay comes back a pixel or two larger, gets set
// to that, and comes back larger again. One call is invisible. Sixty a second,
// which is what dragging did, grew the window by about 48x48 per second -- and
// because the bar is bottom-aligned inside it, a taller window slid the bar
// steadily down the screen while it was being dragged.
//
// This is the only function that decides where the overlay window is or how big
// it is, so the size is pinned in one place and cannot drift anywhere.
let overlayRect = null;

function placeOverlay(rect) {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  overlayRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  try {
    overlayWin.setBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  } catch (_) {}
}

function positionOverlay() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  // A drag owns the window position outright; re-centring it mid-gesture would
  // fight the user's hand.
  if (overlayDrag) return;
  const size = overlaySizeRect();
  if (holdOverlaySize(size)) return;
  placeOverlay(flowBar.rectFor(overlayAnchor(size), size));
}

// The flow bar's capsule shrinks back from a wide shape -- the learned notice,
// an edited result -- on its own ~540ms spring, centred in this window. Taking
// the window in at once cut the still-wide capsule off at both ends for most of
// that morph. So a smaller size waits for the capsule to settle, with the
// larger box hung off the same anchor meanwhile (nothing moves on screen), and
// only then takes the window in; a larger size still applies at once, before
// the capsule grows into it. Any later call replaces a pending shrink.
const OVERLAY_SHRINK_DELAY_MS = 600;
let overlayShrinkTimer = null;

function holdOverlaySize(size) {
  if (overlayShrinkTimer) {
    clearTimeout(overlayShrinkTimer);
    overlayShrinkTimer = null;
  }
  const hold = flowBar.heldSize(overlayRect, size);
  if (!hold) return false;
  placeOverlay(flowBar.rectFor(overlayAnchor(hold), hold));
  overlayShrinkTimer = setTimeout(() => {
    overlayShrinkTimer = null;
    if (!overlayWin || overlayWin.isDestroyed() || overlayDrag) return;
    const settled = overlaySizeRect();
    placeOverlay(flowBar.rectFor(overlayAnchor(settled), settled));
  }, OVERLAY_SHRINK_DELAY_MS);
  return true;
}

// --- Dragging ---------------------------------------------------------------
// The bar is moved from here rather than by a `-webkit-app-region: drag`
// region. The renderer only reports that the grip went down and came back up;
// every frame in between comes from the OS cursor, which is the one coordinate
// space that stays correct as the window crosses a monitor boundary. A drag
// region would also have to fight setIgnoreMouseEvents, which this window
// spends most of its life inside.
let overlayDrag = null;

// Half a frame. The tick is cheap now that it no longer resizes anything, and
// polling twice per frame roughly halves how far the bar can trail the cursor.
const DRAG_TICK_MS = 8;
// A pointerup that never arrives -- Alt+Tab mid-drag, a lock screen, the OS
// taking the capture away -- would otherwise leave the bar glued to the
// cursor with no way to put it down.
const DRAG_MAX_MS = 30000;

function overlayDragTick() {
  if (!overlayDrag) return;
  if (!overlayWin || overlayWin.isDestroyed()) {
    stopOverlayDrag(false);
    return;
  }
  if (Date.now() - overlayDrag.startedAt > DRAG_MAX_MS) {
    stopOverlayDrag(true);
    return;
  }
  let point;
  try {
    point = screen.getCursorScreenPoint();
  } catch (_) {
    return;
  }
  const x = Math.round(point.x - overlayDrag.grabX);
  const y = Math.round(point.y - overlayDrag.grabY);
  // A hand holding still is the common case between flicks, and moving a window
  // to where it already is still costs a full SetWindowPos on a layered window.
  if (x === overlayDrag.x && y === overlayDrag.y) return;
  overlayDrag.x = x;
  overlayDrag.y = y;
  placeOverlay({ x, y, width: overlayDrag.size.width, height: overlayDrag.size.height });
}

function startOverlayDrag() {
  if (!overlayWin || overlayWin.isDestroyed() || !overlayWin.isVisible()) return;
  // Silent: this clears a stale drag only to start a fresh one in the same
  // gesture, so it must not tell the renderer the drag it is beginning has
  // ended.
  stopOverlayDrag(false, true);
  let point;
  try {
    point = screen.getCursorScreenPoint();
  } catch (_) {
    return;
  }
  // Where the window is according to us, never according to getBounds(). The
  // read-back does not round-trip on a scaled display, and a gesture that both
  // read and wrote its own position would accumulate that error into a drift.
  const size = overlaySizeRect();
  const rect = flowBar.rectFor(overlayAnchor(size), size);
  overlayDrag = {
    // Where inside the window the grab happened, held fixed for the whole
    // gesture so the bar does not jump to the pointer on the first frame.
    grabX: point.x - rect.x,
    grabY: point.y - rect.y,
    x: rect.x,
    y: rect.y,
    size,
    startedAt: Date.now(),
    timer: setInterval(overlayDragTick, DRAG_TICK_MS),
  };
}

function stopOverlayDrag(commit, silent) {
  if (!overlayDrag) return;
  const drag = overlayDrag;
  clearInterval(drag.timer);
  overlayDrag = null;
  // The hover poll went quiet for the whole drag; forget the last reading so
  // the next tick tells the renderer where the cursor really is.
  lastCursor = null;
  // Tell the renderer the drag is over. Its own pointerup/lostpointercapture
  // backstops can miss when Windows steals the capture, and window 'blur' never
  // fires on a focusable:false overlay -- so a drag that main ends on its own
  // (the DRAG_MAX_MS backstop, a mode change, a hide) would otherwise leave the
  // renderer's `dragging` latched true with no way down: the bar stays open and
  // onCursor drops every hover reading, until the next dictation happens to
  // clear it. That was the flow bar "stuck in hover" on machines where the
  // renderer's release never arrived. This is sent before any post-drag
  // hud-cursor tick, so the renderer drops `dragging` before the fresh hover
  // verdict lands and can act on it. `silent` is only for the preempt below,
  // which is beginning a new drag rather than ending one.
  if (!silent && overlayWin && !overlayWin.isDestroyed()) {
    try { overlayWin.webContents.send('hud-drag-end'); } catch (_) {}
  }
  if (!commit) return;
  if (!overlayWin || overlayWin.isDestroyed()) return;
  // The bar was free to cross monitors while the button was down. Only the
  // landing is clamped, so a drop half over an edge still leaves all of it
  // reachable on the display it came down on.
  const landed = flowBar.resolveAnchor(
    flowBar.anchorFor({ x: drag.x, y: drag.y, width: drag.size.width, height: drag.size.height }),
    screen.getAllDisplays(),
    screen.getPrimaryDisplay(),
    overlaySizeRect()
  );
  settings.flowBarAnchor = landed;
  try { saveSettings(); } catch (_) {}
  positionOverlay();
  refreshFullscreenUnderBar();
}

function resetFlowBarPosition() {
  settings.flowBarAnchor = null;
  try { saveSettings(); } catch (_) {}
  positionOverlay();
  refreshFullscreenUnderBar();
  ensureOverlayVisible();
}

// The resting bar stands aside while a fullscreen app -- a game, a film -- is
// in front on the bar's own screen. A dictation still brings the bar up over
// it, so the player can see it listening and what it wrote, and it goes again
// once the dictation is done.
let foregroundFullscreen = false;
function restingBarWanted() {
  return !!settings.alwaysShowFlowBar && !foregroundFullscreen;
}

// The monitor the window in front fills, in physical pixels as the watcher
// reports it, or null while nothing in front is fullscreen. Windows' own
// passing surfaces (Start, Alt+Tab) leave it as it was: the game is still
// under them.
let foregroundFillsMonitor = null;

// Whether that monitor is the one the bar rests on. A game on one screen is no
// reason to move a bar on the other; when the two cannot be compared, the bar
// stands aside as it always has.
function fullscreenUnderBar() {
  if (!foregroundFillsMonitor) return false;
  if (!overlayRect) return true;
  try {
    const monitor = process.platform === 'win32' && typeof screen.screenToDipRect === 'function'
      ? screen.screenToDipRect(null, foregroundFillsMonitor)
      : foregroundFillsMonitor;
    return screen.getDisplayMatching(monitor).id === screen.getDisplayMatching(overlayRect).id;
  } catch (_) {
    return true;
  }
}

// Leaving is at once; coming back waits until nothing fullscreen has been in
// front for a moment. A game that flickers through a mode change, or a
// window passed through on the way back to the game, would otherwise slide
// the bar in and straight out again.
const FULLSCREEN_REVEAL_MS = 600;
let fullscreenRevealTimer = null;

function setForegroundFullscreen(full) {
  if (full) {
    if (fullscreenRevealTimer) {
      clearTimeout(fullscreenRevealTimer);
      fullscreenRevealTimer = null;
    }
    applyForegroundFullscreen(true);
    return;
  }
  if (!foregroundFullscreen || fullscreenRevealTimer) return;
  fullscreenRevealTimer = setTimeout(() => {
    fullscreenRevealTimer = null;
    applyForegroundFullscreen(false);
  }, FULLSCREEN_REVEAL_MS);
}

// The bar moved -- a drag, a screen plugged in or out -- so whether the game
// is under it may have changed.
function refreshFullscreenUnderBar() {
  setForegroundFullscreen(fullscreenUnderBar());
}

function applyForegroundFullscreen(full) {
  if (full === foregroundFullscreen) return;
  foregroundFullscreen = full;
  // Nothing rests on screen either way, and a dictation keeps its bar until it
  // returns to idle, which reads restingBarWanted() itself.
  if (!settings.alwaysShowFlowBar || mode !== 'idle') return;
  if (full) {
    // The page slides the bar out, then asks for the window to be hidden.
    sendOverlay({ mode: 'idle' });
  } else {
    showOverlay();
    sendOverlay({ mode: 'idle', reveal: true });
  }
}

// Windows hands "topmost" to whoever asked for it last, so another always-on-top
// window -- a game overlay, a meeting toolbar, a UAC-adjacent shell window --
// can bury the bar with nothing reporting that it happened. The only moment
// that can have changed is when the foreground window changes, so the bar
// reclaims the top there rather than on a timer.
function raiseOverlay() {
  if (!overlayWin || overlayWin.isDestroyed() || !overlayWin.isVisible()) return;
  // Re-asserting the level rather than moveTop(): this is a pure z-order
  // change, where moveTop also re-sends a position and can nudge the bar by a
  // pixel on a scaled display every time it runs.
  try { overlayWin.setAlwaysOnTop(true, 'screen-saver'); } catch (_) {}
}

// The bar should be on screen whenever the user asked for it to be. Anything
// that hid it without going through hideOverlayWindow -- a renderer reload, a
// display swap, a hide that raced a mode change -- gets undone here.
let lastOverlayRescue = 0;

const OVERLAY_RESCUE_MS = 3000;

function ensureOverlayVisible() {
  if (!restingBarWanted()) return;
  if (mode !== 'idle') return;
  if (!overlayWin || overlayWin.isDestroyed()) return;
  if (overlayWin.isVisible()) return;
  // Backing off matters: this runs on the foreground poll, twice a second, and
  // if showing the window does not take -- a compositor that has gone away, a
  // session that is locked -- an unthrottled retry turns a missing bar into a
  // permanent burn of tray rebuilds and IPC on every tick.
  const now = Date.now();
  if (now - lastOverlayRescue < OVERLAY_RESCUE_MS) return;
  lastOverlayRescue = now;
  diagLog('overlay-rescue', { mode });
  showOverlay();
  sendOverlay({ mode: 'idle', reveal: true });
}

// Monitors coming and going is exactly when a saved position stops making
// sense, and the events arrive in bursts, so the answer is computed once the
// dust settles. The saved anchor is deliberately left alone: unplug a screen
// and the bar moves to one that exists, plug it back in and it goes home.
let overlayReflowTimer = null;

function scheduleOverlayReflow() {
  if (overlayReflowTimer) clearTimeout(overlayReflowTimer);
  overlayReflowTimer = setTimeout(() => {
    overlayReflowTimer = null;
    if (overlayDrag) return;
    positionOverlay();
    refreshFullscreenUnderBar();
    ensureOverlayVisible();
    raiseOverlay();
  }, 250);
}

function captureOverlayHwnd() {
  try {
    overlayHwnd = ownWindowId(overlayWin);
  } catch (_) {}
}

// The overlay is click-through most of the time, and a click-through window on
// Windows never gets WM_MOUSELEAVE -- so the renderer cannot tell when the
// pointer leaves. Poll the OS cursor here instead and feed the renderer window
// coordinates; that is the only signal that stays correct in both modes.
let cursorTimer = 0;
let lastCursor = null;
// Whether the pointer is on the resting bar, decided here rather than in the
// renderer. The window is click-through while idle, and it used to become
// clickable only after a round trip -- cursor sample to renderer, hover
// verdict back to main -- so a quick click on the bar could land on whatever
// was behind it. Main knows the cursor and the window; it decides at once.
let overlayHover = false;

const CURSOR_POLL_MS = 40;

// Hover target, in window coordinates; mirrors the renderer's constants. A
// tight entry rect expands into a horizontal band that covers Island's open
// capsule (its settings is inside it) or Orb's sphere and side
// controls. The upper corners stay click-through either way.
const HOVER_ENTER_W = 62;
const HOVER_STAY_W = 114;
const HOVER_ENTER_H = 26;
const HOVER_STAY_H = 46;
const HOVER_BOTTOM = 10;

function inHoverZone(x, y, width, height, stay) {
  const offsetX = Math.abs(x - width / 2);
  const bottom = height - HOVER_BOTTOM;
  if (y > bottom) return false;
  const orb = settings.flowBarStyle === 'orb';
  const zoneH = stay ? (orb ? 50 : HOVER_STAY_H) : orb ? 44 : HOVER_ENTER_H;
  if (offsetX <= (stay ? HOVER_STAY_W : HOVER_ENTER_W) / 2 && y >= bottom - zoneH) return true;
  return false;
}

function overlayCursorTick() {
  if (!overlayWin || overlayWin.isDestroyed() || !overlayWin.isVisible()) return;
  // The bar is under the cursor by definition while it is being carried, and
  // the renderer discards hover readings for the whole gesture anyway.
  if (overlayDrag) return;
  let point;
  try {
    point = screen.getCursorScreenPoint();
  } catch (_) {
    return;
  }
  // The rect placeOverlay last wrote, not a native read-back on every tick.
  const bounds = overlayRect || overlayWin.getContentBounds();
  const x = point.x - bounds.x;
  const y = point.y - bounds.y;
  const inside = x >= 0 && y >= 0 && x <= bounds.width && y <= bounds.height;
  const hover = inside && inHoverZone(x, y, bounds.width, bounds.height, overlayHover);
  const hoverChanged = hover !== overlayHover;
  overlayHover = hover;
  // The pointer arriving on the resting bar is the last moment to make sure
  // a click can still reach the page (see rearmOverlayInput). Once per
  // entry, never per tick; active states were rearmed by showOverlay.
  if (hoverChanged && hover && mode === 'idle' && !overlayEditing) rearmOverlayInput();
  // The renderer only ever turns these readings into a boolean, so it only
  // hears about the boolean changing -- not about every pixel the pointer
  // crosses inside the window.
  setOverlayMouseIgnore(mode === 'idle' && !overlayEditing ? !hover : false);
  if (lastCursor && lastCursor.inside === inside && !hoverChanged) return;
  lastCursor = { x, y, inside, hover };
  try {
    overlayWin.webContents.send('hud-cursor', lastCursor);
  } catch (_) {}
}

function startCursorWatch() {
  if (cursorTimer) return;
  lastCursor = null;
  cursorTimer = setInterval(overlayCursorTick, CURSOR_POLL_MS);
}

function stopCursorWatch() {
  if (cursorTimer) clearInterval(cursorTimer);
  cursorTimer = 0;
  lastCursor = null;
}

// Never with { forward: true }. On Windows, Electron implements forwarding
// by installing a system-wide low-level mouse hook (WH_MOUSE_LL) inside this
// process, so every mouse movement on the PC is held until the main thread
// gets round to it -- and when the main thread is busy, Windows holds each
// move for its hook timeout, about 300 ms. That was the cursor stutter on
// every launch and on every heavy moment afterwards, on every machine, with
// or without a speech engine installed. Nothing here needed the forwarded
// moves: hover is decided from the cursor poll above and sent to the page as
// hud-cursor, and the page ignores mousemove while click-through on purpose.
// Measured: worst mouse delay during launch went from 304 ms to under 3 ms.
function setOverlayMouseIgnore(ignore) {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  // A game dictation's bar never takes a click: the game under it would lose
  // the click, and one on the result would pull focus from the game to edit
  // it. The game shortcut is the bar's only control then.
  if (gameDictation && mode !== 'idle') ignore = true;
  if (overlayIgnoreMouse === ignore) return;
  try {
    overlayWin.setIgnoreMouseEvents(!!ignore);
    overlayIgnoreMouse = ignore;
  } catch (_) {
    // A failed native call must be retried, even when the desired flag has
    // not changed on the next cursor tick.
    overlayIgnoreMouse = null;
  }
}

// A window that comes back from hide() with showInactive() looks right and
// even reports hover, but no mouse-down reaches the page until it is resized.
// The same is true after Windows minimizes and restores the bar, and after
// anything Chromium counted as occlusion (see the CalculateNativeWinOcclusion
// note at the top). In every case Chromium hid the child window that takes
// the renderer's input and, with backgroundThrottling off, only re-shows it
// from RenderWidgetHostViewAura::InternalSetBounds -- a size change. A move
// alone does not count, and neither does toggling click-through or the
// always-on-top level; measured with real OS clicks, only the resize below
// brought the page back. So this runs wherever the bar becomes clickable:
// after a show, when the pointer arrives on the resting bar, and after wake.
//
// One pixel of height and straight back, both from our own rect so the
// scaled-display rounding never drifts in. The pixel grows upward into the
// transparent headroom above the pill, so a bottom-anchored bar the user is
// looking at does not hop.
function rearmOverlayInput() {
  if (!overlayWin || overlayWin.isDestroyed() || !overlayRect) return;
  // A drag owns the rect; resizing under it would make the bar jump.
  if (overlayDrag) return;
  const rect = overlayRect;
  placeOverlay({ x: rect.x, y: rect.y - 1, width: rect.width, height: rect.height + 1 });
  placeOverlay(rect);
}

function showOverlay() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  positionOverlay();
  if (!overlayWin.isVisible()) overlayWin.showInactive();
  // Not only after a show of our own: the input child window is also lost
  // when Windows minimizes and restores the bar, or on a build where
  // occlusion still hides it, and the window reports visible throughout.
  // Every path that makes the bar clickable -- a dictation starting, a
  // result landing, a rebuilt page -- passes here.
  rearmOverlayInput();
  raiseOverlay();
  captureOverlayHwnd();
  // Settings can re-show an already visible bar while its grip is held.
  // The cursor poll deliberately pauses during a drag, so forcing idle input
  // off here would leave the release unable to reach the page.
  setOverlayMouseIgnore(mode === 'idle' && !overlayEditing && !overlayDrag && !overlayHover);
  startCursorWatch();
}

// setFocusable(false) is not only a style change on Windows. Electron also
// takes the bar out of the taskbar's list and deactivates it, and Chromium's
// deactivate hands the foreground to the next visible window below. The bar
// is unfocusable everywhere but the result editor, so nearly every call found
// nothing to give up -- yet it still moved the foreground, and the taskbar's
// window list that was in front closed before it could be clicked (traced
// 2026-10-05). Only a bar that can take focus now is changed.
function makeUnfocusable(win) {
  if (!win || win.isDestroyed()) return;
  try {
    if (win.isFocusable()) win.setFocusable(false);
  } catch (_) {}
}

function hideOverlayWindow() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  if (restingBarWanted()) return;
  stopOverlayDrag(false);
  if (mode === 'arming' || mode === 'recording' || mode === 'transcribing' || mode === 'success' || mode === 'error' || mode === 'learned' || mode === 'cancel') return;
  makeUnfocusable(overlayWin);
  setOverlayMouseIgnore(true);
  stopCursorWatch();
  overlayWin.hide();
}

function isOurHwnd(hwnd) {
  if (!hwnd || hwnd === '0') return true;
  if (hwnd === overlayHwnd || hwnd === historyHwnd) return true;
  return false;
}

// The dashboard contains editable fields too (feedback, dictionary, Polish).
// Keep it excluded from screenshot targets and correction watchers, while
// allowing dictation to choose it instead of retaining a previous app.
function isDictationTarget(hwnd) {
  if (!hwnd || hwnd === '0') return false;
  return hwnd === historyHwnd || !isOurHwnd(hwnd);
}

// --- Flow bar health ---------------------------------------------------------
// The bar can be on screen, on top and in the right place with nothing
// running inside it. A renderer that crashed leaves a blank transparent
// window that still reports visible; one whose event loop is wedged looks
// exactly like a healthy idle bar. The visibility rescue above cannot see
// either, and neither can the user -- what they see is a bar that stopped
// answering the mouse and a hotkey that does nothing.
//
// So the page is asked. Main sends a numbered ping on a slow clock from the
// foreground tick, the page answers it, and overlay-health.js keeps score.
// Electron's own crash and unresponsive events feed the same place. Once a
// page is judged dead the window is destroyed and built again from the saved
// position; the fresh page's hud-ready then puts it back on screen the way a
// launch does. A busy page gets extra time to recover before its recording is
// abandoned; excluding every busy state would leave a permanently wedged page
// stuck forever, including after Stop or while a success edit is held open.
//
// The clocks are overridable for the test that freezes the page on purpose;
// nothing in production sets them.
const HUD_PING_MS = envInt('VOXDEN_FLOW_BAR_PING_MS', 5000);
const HUD_PING_TIMEOUT_MS = envInt('VOXDEN_FLOW_BAR_PING_TIMEOUT_MS', 4000);
const HUD_PING_MISSES = envInt('VOXDEN_FLOW_BAR_PING_MISSES', 3);
// A page that dies on load would otherwise be rebuilt as fast as it dies.
const OVERLAY_RECREATE_MIN_MS = envInt('VOXDEN_FLOW_BAR_RECREATE_MIN_MS', 10000);
const OVERLAY_READY_TIMEOUT_MS = envInt('VOXDEN_FLOW_BAR_READY_TIMEOUT_MS', 20000);
const OVERLAY_BUSY_GRACE_MS = envInt('VOXDEN_FLOW_BAR_BUSY_GRACE_MS', 10000);
const OVERLAY_FRAME_RECOVERY_MIN_MS = envInt('VOXDEN_FLOW_BAR_FRAME_RECOVERY_MIN_MS', 30000);
// The foreground tick is due every HWND_TICK_MS. Firing this much later than
// that is main's own loop not turning -- or the machine asleep, which the
// power events written to the same log tell apart.
const MAIN_STALL_MS = 2000;

const overlayHealth = createHealthMonitor({ timeoutMs: HUD_PING_TIMEOUT_MS, misses: HUD_PING_MISSES });
const overlayFrameHealth = createFrameMonitor({ timeoutMs: HUD_PING_TIMEOUT_MS, misses: HUD_PING_MISSES });
let lastOverlayFrameRecovery = 0;
let overlayFrameRestore = null;
let overlayScreenLocked = false;
let overlaySystemSuspended = false;
let overlayReady = false;
let openingCuePending = true;
let lastHwndTickAt = 0;
let lastHudPingAt = 0;
let lastOverlayRecreate = 0;
let overlayRecreates = 0;
let overlayRecreateTimer = null;
let overlayFrozenNoted = false;
let overlayFrozenSince = null;
let overlayLoadStartedAt = null;

function resetOverlayHealth(now = Date.now()) {
  overlayHealth.reset();
  overlayFrameHealth.reset();
  lastHudPingAt = now;
  overlayFrozenNoted = false;
  overlayFrozenSince = null;
  // Loading time while main was stalled or the machine asleep is not proof
  // that the renderer failed to initialize.
  if (!overlayReady) overlayLoadStartedAt = now;
}

function overlayHealthTick(now) {
  const late = timerLateness(HWND_TICK_MS, lastHwndTickAt, now);
  lastHwndTickAt = now;
  if (late >= MAIN_STALL_MS) {
    // Nothing the page did or did not answer during that gap says anything
    // about the page.
    diagLog('main-stall', { lateMs: late, mode });
    resetOverlayHealth(now);
    return;
  }
  if (!overlayWin || overlayWin.isDestroyed()) return;
  if (overlayScreenLocked || overlaySystemSuspended) {
    resetOverlayHealth(now);
    return;
  }
  restoreOverlayFrameSurface(now);
  // A script or preload failure can prevent hud-ready entirely. Such a page
  // never reaches the ping monitor, and may not even be visible yet.
  if (!overlayReady) {
    if (overlayLoadStartedAt !== null && now - overlayLoadStartedAt >= OVERLAY_READY_TIMEOUT_MS) {
      recreateOverlay('ready-timeout', { waitedMs: now - overlayLoadStartedAt });
    }
    return;
  }
  if (!overlayWin.isVisible()) {
    resetOverlayHealth(now);
    return;
  }
  const verdict = overlayHealth.check(now);
  if (verdict.status === 'frozen') {
    overlayFrozen('ping', { missed: verdict.missed, sinceAnswer: verdict.sinceAnswer });
    return;
  }
  overlayFrozenNoted = false;
  overlayFrozenSince = null;
  const frameVerdict = overlayFrameHealth.check(now);
  if (frameVerdict.stalled && verdict.status === 'ok') {
    recoverOverlayFrames(now, frameVerdict);
  }
  if (now - lastHudPingAt < HUD_PING_MS) return;
  const seq = overlayHealth.send(now);
  if (seq === null) return;
  lastHudPingAt = now;
  overlayFrameHealth.send(seq, now);
  try {
    overlayWin.webContents.send('hud-ping', seq);
  } catch (_) {}
}

function recoverOverlayFrames(now, info) {
  if (!overlayWin || overlayWin.isDestroyed() || !overlayWin.isVisible()
      || overlayScreenLocked || overlaySystemSuspended) return;
  // Hiding a focused result editor causes blur/commit. Wait until that edit
  // finishes; a static result does not need motion to remain usable.
  if (overlayEditing || overlayDrag || overlayWin.isFocused()) {
    overlayFrameHealth.reset();
    return;
  }
  if (lastOverlayFrameRecovery && now - lastOverlayFrameRecovery < OVERLAY_FRAME_RECOVERY_MIN_MS) return;
  lastOverlayFrameRecovery = now;
  diagLog('overlay-frame-recovery', { mode, missed: info.missed });
  try {
    // The page is alive. Preserve its microphone, recording and HUD state;
    // only re-show the native surface whose frame delivery stopped. A resize
    // alone does not recover this compositor failure on Windows.
    overlayWin.hide();
    overlayFrameRestore = { win: overlayWin, nextAt: now };
    restoreOverlayFrameSurface(now);
  } catch (err) {
    diagLog('overlay-frame-recovery-failed', { code: String(err && err.code || '') });
  }
  resetOverlayHealth(now);
}

function restoreOverlayFrameSurface(now) {
  const pending = overlayFrameRestore;
  if (!pending) return;
  if (pending.win !== overlayWin || pending.win.isDestroyed()) {
    overlayFrameRestore = null;
    return;
  }
  // A failed native show may outlive a settings change or the dictation that
  // needed the bar. Do not resurrect an idle surface the user has hidden.
  if (mode === 'idle' && !restingBarWanted()) {
    overlayFrameRestore = null;
    return;
  }
  if (overlayScreenLocked || overlaySystemSuspended) return;
  if (now < pending.nextAt) return;
  // A failed native show must not leave a live recording invisible. Retry
  // the same page at the ping cadence, including while main is recording.
  pending.nextAt = now + Math.max(1000, HUD_PING_MS);
  try {
    if (!overlayWin.isVisible()) overlayWin.showInactive();
    if (!overlayWin.isVisible()) return;
    overlayFrameRestore = null;
    rearmOverlayInput();
    raiseOverlay();
    overlayIgnoreMouse = null;
    // A shortcut can start recording while a failed show is being retried.
    // Restore input from the current state, never the pre-recovery cache.
    setOverlayMouseIgnore(mode === 'idle' && !overlayEditing && !overlayDrag && !overlayHover);
  } catch (err) {
    diagLog('overlay-frame-recovery-failed', { code: String(err && err.code || '') });
  }
}

function overlayFrozen(source, info) {
  if (mode !== 'idle') {
    // Noted once, not once a second for the length of the dictation.
    if (!overlayFrozenNoted) diagLog('overlay-frozen-busy', Object.assign({ source, mode }, info || {}));
    overlayFrozenNoted = true;
    if (overlayFrozenSince === null) overlayFrozenSince = Date.now();
    // This measures silence from the renderer, never elapsed ASR work. A slow
    // model whose page still answers pings must keep its recording intact.
    if (Date.now() - overlayFrozenSince < OVERLAY_BUSY_GRACE_MS) return;
  }
  recreateOverlay(source, info);
}

// Everything a dictation in flight holds, let go of without a verdict. Used
// when the page carrying the dictation is gone: there is no recording to
// transcribe and nobody to show an error to.
function abandonDictation(why) {
  diagLog('dictation-abandoned', { why, mode });
  clearArmingTimer();
  advanceRecordingSession();
  pttReleasePending = false;
  pttLocked = false;
  pttIgnoreNextUp = false;
  mediaPreparing = false;
  corpus.dropParked();
  registerEscape(false);
  recordingStartedAt = 0;
  lastDurationMs = 0;
  dictationTiming = null;
  armTiming = null;
  if (successTimer) clearTimeout(successTimer);
  successTimer = null;
  mode = 'idle';
  resumeBackgroundMedia();
}

function recreateOverlay(reason, info) {
  if (isQuitting) return;
  const now = Date.now();
  const wait = OVERLAY_RECREATE_MIN_MS - (now - lastOverlayRecreate);
  if (lastOverlayRecreate && wait > 0) {
    // Not dropped, deferred: a crash has no second event to try again on.
    if (!overlayRecreateTimer) {
      diagLog('overlay-recreate-deferred', { reason, waitMs: wait });
      overlayRecreateTimer = setTimeout(() => {
        overlayRecreateTimer = null;
        if (!overlayWin || overlayWin.isDestroyed() || !overlayReady) recreateOverlay(reason + '-retry');
      }, wait);
    }
    return;
  }
  lastOverlayRecreate = now;
  overlayRecreates += 1;
  diagLog('overlay-recreate', Object.assign({ reason, mode, count: overlayRecreates }, info || {}));
  if (mode !== 'idle') abandonDictation('overlay-recreate');
  overlayReady = false;
  resetOverlayHealth(now);
  // Silent: the page this would be telling is the one being thrown away.
  stopOverlayDrag(false, true);
  stopCursorWatch();
  const old = overlayWin;
  overlayWin = null;
  overlayHwnd = '0';
  overlayIgnoreMouse = null;
  overlayHover = false;
  overlayEditing = false;
  overlayRect = null;
  lastCursor = null;
  if (old && !old.isDestroyed()) {
    try { old.destroy(); } catch (_) {}
  }
  createOverlay();
}

// Sleep and the lock screen both take the compositor away and hand it back,
// and the window that comes back is not quite the one that went: the
// click-through flag main remembers may no longer be what the OS has, the
// child window that takes the page's input can be gone the same way it goes
// after hide() and showInactive(), and a drag or hover latched when the lid
// closed has no pointer to release it. Everything main knows about the
// pointer is reset and the window is woken the way showOverlay wakes it.
function rearmOverlayAfterWake(reason) {
  if (reason === 'resume') overlaySystemSuspended = false;
  if (reason === 'unlock-screen') overlayScreenLocked = false;
  const visible = !!(overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible());
  diagLog('power-' + reason, { mode, visible });
  resetOverlayHealth();
  lastHwndTickAt = 0;
  if (!overlayWin || overlayWin.isDestroyed()) return;
  stopOverlayDrag(false);
  lastCursor = null;
  overlayHover = false;
  // Forget the cached flag so the next call reaches the OS whatever it says.
  overlayIgnoreMouse = null;
  setOverlayMouseIgnore(mode === 'idle' && !overlayEditing);
  if (visible) {
    rearmOverlayInput();
    raiseOverlay();
  }
}

function pauseOverlayHealth(reason) {
  if (reason === 'suspend') overlaySystemSuspended = true;
  if (reason === 'lock-screen') overlayScreenLocked = true;
  resetOverlayHealth();
  diagLog('power-' + reason, { mode });
}

function createOverlay() {
  const icon = windowIconPath() || appIconPath();
  const { ww, wh } = overlaySize();
  overlayReady = false;
  resetOverlayHealth();
  overlayWin = new BrowserWindow({
    width: ww,
    height: wh,
    useContentSize: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,
    focusable: false,
    show: false,
    icon: icon || undefined,
    title: 'Vell',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  try { overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) {}
  overlayWin.setMenuBarVisibility(false);
  lockToAppPages(overlayWin);
  setOverlayMouseIgnore(true);
  applyWindowIcon(overlayWin);
  const win = overlayWin;
  win.once('ready-to-show', () => {
    if (win !== overlayWin) return;
    applyWindowIcon(win);
    positionOverlay();
    captureOverlayHwnd();
  });
  // Every handler checks it still belongs to the current window: a window on
  // its way out during a recreate must not act on the one replacing it.
  win.webContents.on('did-start-loading', () => {
    if (win !== overlayWin) return;
    // A reload discards the old page's audio and awaited transcription. Only
    // an initial cold load can safely replay an arming request on hud-ready.
    if (overlayReady && mode !== 'idle') abandonDictation('renderer-reload');
    overlayEditing = false;
    makeUnfocusable(win);
    overlayReady = false;
    resetOverlayHealth();
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    if (win !== overlayWin) return;
    overlayReady = false;
    diagLog('renderer-gone', {
      reason: details && details.reason,
      exitCode: details && details.exitCode,
      mode,
    });
    recreateOverlay('renderer-gone');
  });
  win.on('unresponsive', () => {
    if (win !== overlayWin) return;
    diagLog('renderer-unresponsive', { mode });
    overlayFrozen('unresponsive');
  });
  win.on('responsive', () => {
    if (win !== overlayWin) return;
    diagLog('renderer-responsive', { mode });
  });
  win.on('closed', () => {
    if (win !== overlayWin) return;
    stopCursorWatch();
    overlayWin = null;
    overlayIgnoreMouse = null;
  });
  win.loadFile(path.join(__dirname, 'overlay.html')).catch(err => {
    if (win !== overlayWin || isQuitting) return;
    overlayReady = false;
    diagLog('overlay-load-failed', { code: err && err.code });
    recreateOverlay('load-failed');
  });
}

// The dashboard is designed at 1200x780. Smaller screens get whatever their
// work area allows, never less than the minimum size below.
function historyWindowSize() {
  const want = { width: 1200, height: 780 };
  try {
    const area = screen.getPrimaryDisplay().workAreaSize;
    if (!area || !area.width || !area.height) return want;
    return {
      width: Math.max(640, Math.min(want.width, area.width - 40)),
      height: Math.max(440, Math.min(want.height, area.height - 40)),
    };
  } catch (_) {
    return want;
  }
}

function createHistoryWindow() {
  historySnapshotPending = true;
  const icon = windowIconPath() || appIconPath();
  const colors = appTheme.chrome(settings.appTheme);
  const size = historyWindowSize();
  historyWin = new BrowserWindow({
    width: size.width,
    height: size.height,
    minWidth: 640,
    minHeight: 440,
    backgroundColor: colors.background,
    title: 'Vell',
    icon: icon || undefined,
    autoHideMenuBar: true,
    show: false,
    titleBarStyle: 'hidden',
    trafficLightPosition: macShell.trafficLightPosition(process.platform),
    titleBarOverlay: {
      // Must match --titlebar-bg in theme.css and .titlebar height so the
      // native Windows controls read as part of the header, not a dark box.
      color: colors.background,
      symbolColor: colors.symbols,
      height: 60,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: ['--voxden-theme-bootstrap'],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  historyWin.setMenuBarVisibility(false);
  lockToAppPages(historyWin);
  applyWindowIcon(historyWin);
  historyWin.on('show', refreshHistoryWindow);
  historyWin.on('restore', refreshHistoryWindow);
  historyWin.on('ready-to-show', () => {
    applyWindowIcon(historyWin);
    try {
      historyHwnd = ownWindowId(historyWin);
    } catch (_) {}
  });
  if (!process.argv.includes('--hidden') && !macShell.openedAtLogin(app, process.platform)) {
    let opened = false;
    const openWhenReady = () => {
      if (opened) return;
      opened = true;
      openHistory();
    };
    historyWin.once('ready-to-show', openWhenReady);
    historyWin.webContents.once('did-finish-load', openWhenReady);
  }
  historyWin.loadFile(path.join(__dirname, 'app.html'));
  historyWin.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      historyWin.hide();
      if (!settings.showInTaskbar) {
        try { historyWin.setSkipTaskbar(true); } catch (_) {}
      }
    }
  });
  historyWin.on('closed', () => { historyWin = null; historyHwnd = '0'; });
}

// settingsCat opens the window straight onto one settings pane, which is how
// the tray reaches things it has no business duplicating in a menu.
function openHistory(settingsCat) {
  if (!historyWin || historyWin.isDestroyed()) createHistoryWindow();
  applyWindowIcon(historyWin);
  try { historyWin.setSkipTaskbar(false); } catch (_) {}
  historySnapshotPending = true;
  if (historyWin.isMinimized()) historyWin.restore();
  macShell.bringForward(app, process.platform);
  historyWin.show();
  historyWin.focus();
  try {
    historyHwnd = ownWindowId(historyWin);
  } catch (_) {}
  // A native show/restore may already have sent it. Calling again also covers
  // an existing visible window without duplicating that same full snapshot.
  refreshHistoryWindow();
  if (!settingsCat) return;
  const cat = String(settingsCat);
  // A window created a moment ago has not loaded app.js yet, so a message sent
  // now lands nowhere. Hold it for the app-ready the renderer sends on load --
  // the same handshake the initial snapshot already relies on.
  if (historyWin.webContents.isLoading()) pendingSettingsCat = cat;
  else historyWin.webContents.send('open-settings', cat);
}

function setDictateMode(next) {
  if (next !== 'ptt' && next !== 'toggle') return;
  settings.dictateMode = next;
  if (next === 'toggle') pttReleasePending = false;
  saveSettings();
  broadcast();
}

function setMicrophone(id) {
  const next = String(id || 'default');
  if (settings.microphone === next) return;
  settings.microphone = next;
  saveSettings();
  broadcast();
}

// The device the tray should show as chosen. A microphone that has since been
// unplugged must not leave every radio unchecked, so an id that is no longer in
// the list reads as the system default -- which is what capture falls back to
// anyway.
function activeMicId() {
  const current = settings.microphone || 'default';
  if (current === 'default') return 'default';
  return micDevices.some((d) => d.id === current) ? current : 'default';
}

function microphoneSubmenu() {
  const active = activeMicId();
  const defaultDevice = micDevices.find((d) => d.id === micDefaultId);
  const items = [{
    label: defaultDevice ? 'System default (' + defaultDevice.label + ')' : 'System default',
    type: 'radio',
    checked: active === 'default',
    click: () => setMicrophone('default'),
  }];
  if (micDevices.length) {
    items.push({ type: 'separator' });
    for (const device of micDevices) {
      items.push({
        label: device.label,
        type: 'radio',
        checked: active === device.id,
        click: () => setMicrophone(device.id),
      });
    }
  }
  items.push({ type: 'separator' });
  // The pane has the level meter and the device test, which a menu cannot show.
  items.push({ label: 'Microphone settings…', click: () => openHistory('general#microphone') });
  return items;
}

function setTrayFlag(key, value) {
  settings[key] = !!value;
  saveSettings();
  if (key === 'launchAtLogin') applySystemSettings();
  broadcast();
}

// Everything the menu reads, flattened. Rebuilding on every overlay tick would
// be wasteful and rebuilding only at startup would leave the menu lying about
// its own checkboxes, so the rebuild is driven by whether any of this changed.
function trayMenuSignature() {
  return [
    mode === 'arming' || mode === 'recording' ? 'busy' : 'idle',
    settings.shortcut,
    settings.pasteLastShortcut,
    settings.dictateMode,
    settings.verbatimMode ? 'v1' : 'v0',
    settings.muteMusicWhileDictating !== false ? 'm1' : 'm0',
    settings.launchAtLogin ? 'l1' : 'l0',
    lastDictationText() ? 'paste' : 'nopaste',
    activeMicId(),
    micDefaultId,
    micDevices.map((d) => d.id + ':' + d.label).join(','),
  ].join('|');
}

function buildTrayTemplate() {
  const busy = mode === 'arming' || mode === 'recording';
  const words = macShell.trayLabels(process.platform);
  return [
    { label: 'Open Vell', click: () => openHistory() },
    { type: 'separator' },
    {
      // The one item whose label is worth changing: from the tray there is no
      // other sign of whether a dictation is already running.
      label: trayMenuLabel(busy ? 'Finish dictation' : 'Start dictation', settings.shortcut),
      click: () => dictationHotkeyHandler(),
    },
    {
      label: trayMenuLabel('Paste last dictation', settings.pasteLastShortcut),
      enabled: !!lastDictationText(),
      click: () => { pasteLastDictation().catch(() => {}); },
    },
    { type: 'separator' },
    {
      label: 'Dictation mode',
      submenu: [
        { label: 'Toggle', type: 'radio', checked: !isPtt(), click: () => setDictateMode('toggle') },
        { label: 'Push to talk', type: 'radio', checked: isPtt(), click: () => setDictateMode('ptt') },
      ],
    },
    { label: 'Microphone', submenu: microphoneSubmenu() },
    {
      label: 'Verbatim mode',
      type: 'checkbox',
      checked: !!settings.verbatimMode,
      click: (item) => setTrayFlag('verbatimMode', item.checked),
    },
    ...(mediaControlSupported() ? [{
      label: 'Mute other audio while dictating',
      type: 'checkbox',
      checked: settings.muteMusicWhileDictating !== false,
      click: (item) => setTrayFlag('muteMusicWhileDictating', item.checked),
    }] : []),
    { type: 'separator' },
    {
      // Links into Settings; microphone selection has its own submenu above.
      label: 'Settings',
      submenu: [
        { label: 'General', click: () => openHistory('general') },
        { label: 'Speech engines', click: () => openHistory('speech-engines') },
        // Microphone is deliberately absent: it has its own submenu above, and
        // that one already links to its row in General.
        { label: 'Dictation language', click: () => openHistory('general#dictation-language') },
        { label: 'Sound', click: () => openHistory('sound') },
        { label: 'Data and privacy', click: () => openHistory('privacy') },
      ],
    },
    {
      label: words.launchAtLogin,
      type: 'checkbox',
      checked: !!settings.launchAtLogin,
      click: (item) => setTrayFlag('launchAtLogin', item.checked),
    },
    { type: 'separator' },
    { label: words.quit, click: () => app.quit() },
  ];
}

function refreshTray() {
  if (!tray || tray.isDestroyed()) return;
  const sig = trayMenuSignature();
  if (sig === trayMenuSig) return;
  trayMenuSig = sig;
  try {
    tray.setContextMenu(Menu.buildFromTemplate(buildTrayTemplate()));
  } catch (_) {
    // This runs from sendOverlay, which fires mid-dictation. A tray that failed
    // to rebuild is worth far less than a recording, so it must not throw into
    // the caller.
    trayMenuSig = '';
  }
}

function createTray() {
  const img = trayImage();
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip('Vell');
  trayMenuSig = '';
  refreshTray();
  tray.on('double-click', () => openHistory());
}

// Pausing players and muting the speakers is the Windows helper's work. The
// Mac helper has no media control, so there the switch is hidden and the
// microphone does not wait on the start cue for a mute that never comes.
function mediaControlSupported() {
  return process.platform === 'win32';
}

function muteMusicEnabled() {
  return mediaControlSupported() && settings.muteMusicWhileDictating !== false;
}

function mediaCommand(args) {
  // The helper reports each successful pause immediately. Retain those
  // receipts even if a different player's request subsequently times out.
  return ps(args, 4000);
}

// Every output is muted for the recording only once the start cue has left
// the speakers. A fixed 90 ms used to stand in for that and cut the cue off:
// after half a minute of quiet Chromium lets the output device go, and
// reopening it put the cue 50-100 ms late, under the mute. Measured against
// Windows' own meter on 2026-09-24.
let startCueHeard = null;
function startCueWindow(token) {
  return new Promise((resolve) => {
    const started = Date.now();
    let timer = null;
    const done = (heard) => {
      clearTimeout(timer);
      if (startCueHeard && startCueHeard.token === token) startCueHeard = null;
      if (!heard) diagLog('start-cue-unheard', { waitMs: Date.now() - started });
      resolve();
    };
    timer = setTimeout(() => done(false), START_CUE_MAX_WAIT_MS);
    startCueHeard = { token, done };
  });
}

function pauseBackgroundMedia() {
  const enabled = muteMusicEnabled();
  const cueWindow = enabled && settings.soundsEnabled !== false
    ? startCueWindow(recordingSessionToken)
    : null;
  return backgroundMedia.begin(enabled, cueWindow);
}

function resumeBackgroundMedia() {
  return backgroundMedia.end();
}

function parseWinInfo(out) {
  const line = String(out || '').trim();
  if (!line) return { hwnd: '0', exe: '', title: '' };
  const parts = line.split('\t');
  return {
    hwnd: parts[0] || '0',
    exe: parts[1] || '',
    title: parts.slice(2).join('\t') || '',
  };
}

async function winInfo(hwnd) {
  const args = ['info'];
  if (hwnd && hwnd !== '0') args.push('-Hwnd', String(hwnd));
  const out = await ps(args);
  return parseWinInfo(out);
}

async function rememberFocus() {
  const info = await winInfo();
  if (isDictationTarget(info.hwnd)) {
    lastHwnd = info.hwnd;
    lastTarget = info;
    if (!isOurHwnd(info.hwnd)) lastExternalHwnd = info.hwnd;
  }
}

function startRecording(fromPtt, { game = false } = {}) {
  const pressedAt = Date.now();
  if (isQuitting) return;
  if (mode === 'arming' || mode === 'recording' || mode === 'transcribing') return;
  if (asrOperation || asrIsDisabled() || sidecarState === 'unavailable') {
    if (game) {
      flashError('The speech engine is not ready yet');
      return;
    }
    openHistory('speech-engines');
    return;
  }
  stopCorrectionLearning();
  autoLearnNotice = null;
  autoLearnReceipt = null;
  requestSidecarStart();
  const sessionToken = advanceRecordingSession();
  gameDictation = game;
  pttOwner = fromPtt && isPtt() ? (game ? 'game' : 'dictation') : null;
  corpus.clearRetry();
  // A live copy left over from the dictation before this one would otherwise
  // have this one appended to it.
  endLiveClip();
  retryEntryOwner = null;
  if (successTimer) clearTimeout(successTimer);
  recordingStartedAt = 0;
  lastDurationMs = 0;
  dictationTiming = null;
  armTiming = { pressAt: pressedAt, cueAt: 0, mediaAt: 0, readyAt: 0, micMs: null, holdMs: null };
  pttReleasePending = false;
  pttLocked = false;
  pttIgnoreNextUp = false;
  const pttSession = !!fromPtt && isPtt();
  // Do not call this "recording" until the renderer has a live audio graph.
  // Short commands often begin immediately; showing the waveform while
  // getUserMedia is still starting silently clips their first word.
  mode = 'arming';
  // PTT has a physical key-up deadline, so open its microphone immediately.
  // Waiting for the optional media pause made short holds end during arming and
  // appear not to register. Toggle mode keeps the tail of a song off the
  // recording by not *using* what the microphone hears until the pause is done
  // (`prepareOnly` below: the page opens the microphone at once but holds its
  // audio back), not by leaving the microphone shut. Waiting to open it used to
  // put the microphone's own start -- getUserMedia, the audio graph, the first
  // buffer -- after the start cue and the pause instead of beside them.
  mediaPreparing = !pttSession;
  showOverlay();
  sendOverlay({ mode: 'arming', prepareOnly: mediaPreparing, reveal: true, playStartCue: true, cueToken: sessionToken });
  // Escape is taken system-wide while it cancels. In a game it is the key
  // that closes the chat or opens the menu, so a game dictation leaves it
  // to the game; the game shortcut is how that dictation ends.
  registerEscape(!game);
  // If the page never reports its microphone open, give up on this attempt
  // rather than hold "arming" until Escape. The error state tells the page to
  // bump its capture generation, so a getUserMedia that answers after this
  // has its tracks stopped on arrival instead of becoming a recording.
  clearArmingTimer();
  armingTimer = setTimeout(() => {
    armingTimer = null;
    if (isQuitting || sessionToken !== recordingSessionToken || mode !== 'arming') return;
    diagLog('arming-timeout', {
      ptt: pttSession, mediaPreparing, sidecarState,
      cueMs: armTiming && armTiming.cueAt ? armTiming.cueAt - armTiming.pressAt : -1,
      mediaMs: armTiming && armTiming.mediaAt ? armTiming.mediaAt - armTiming.pressAt : -1,
    });
    mediaPreparing = false;
    flashError('Microphone did not start');
  }, ARMING_TIMEOUT_MS);

  // The foreground watcher already gives us a usable cached paste target.
  // Refresh its metadata while media is paused. Show the preparing HUD now,
  // but do not open the microphone until any old resume and this pause settle.
  rememberFocus().catch(() => {});
  const mediaPause = pauseBackgroundMedia();
  if (!pttSession) mediaPause.then(() => {
    if (isQuitting || sessionToken !== recordingSessionToken || mode !== 'arming') return;
    if (armTiming) armTiming.mediaAt = Date.now();
    mediaPreparing = false;
    sendOverlay({ mode: 'arming', prepareOnly: false });
  }).catch(() => {});
  else mediaPause.catch(() => {});
}

async function requestStop() {
  if (mode === 'arming') {
    cancelListen();
    return;
  }
  if (mode !== 'recording') return;
  if (recordingStartedAt > 0) {
    lastDurationMs = Math.max(0, Date.now() - recordingStartedAt);
    recordingStartedAt = 0;
  }
  pttReleasePending = false;
  pttLocked = false;
  dictationTiming = metrics.beginDictationTiming(Date.now());
  mode = 'transcribing';
  prestartCorrectionLearning();
  sendOverlay({ mode: 'stop' });
  registerEscape(!gameDictation);
}

// The physical DOWN edge. While a tapped dictation is locked on, the next
// press is the one that ends it. `opts` reaches startRecording: the game
// shortcut passes { game: true }.
function pttPress(opts) {
  const owner = opts && opts.game ? 'game' : 'dictation';
  if (pttLocked && (mode === 'arming' || mode === 'recording')) {
    pttOwner = owner;
    pttLocked = false;
    pttIgnoreNextUp = true;
    requestPttStop();
    return;
  }
  // A recording started by clicking the bar belongs to no key, so the first
  // shortcut pressed during it takes it over and ends it on release, as it
  // did before there were two shortcuts.
  if ((mode === 'arming' || mode === 'recording') && pttOwner === null) {
    pttOwner = owner;
    pttPressedAt = Date.now();
    return;
  }
  // The other shortcut may be part of normal keyboard use while this one
  // is held. It must not reset the tap timer or take over the recording.
  if (mode === 'arming' || mode === 'recording' || mode === 'transcribing') return;
  pttPressedAt = Date.now();
  startRecording(true, opts);
}

// The physical UP edge. A release within PTT_TAP_MS of the press locks the
// dictation on instead of ending it; a dirty tap still cancels, because the
// chord was really some other shortcut.
//
// `opts.heldMs` is the watcher's own measure of the hold, and it decides.
// Timing it here, from when the DOWN line was read, let a main thread busy at
// the press read DOWN beside its UP: a two-second hold measured as an instant
// tap and locked the dictation on (reported 2026-10-18). This clock is only
// the fallback for a release that carries no time.
function pttRelease(dirty, opts) {
  const key = opts && opts.game ? 'game' : 'dictation';
  if (pttOwner !== key) return;
  if (pttIgnoreNextUp) {
    pttIgnoreNextUp = false;
    return;
  }
  if (dirty) {
    cancelListen();
    return;
  }
  const active = mode === 'arming' || mode === 'recording';
  const readMs = pttPressedAt ? Date.now() - pttPressedAt : null;
  const heldMs = opts && Number.isFinite(opts.heldMs) ? opts.heldMs : readMs;
  if (active && readMs !== null && Math.abs(heldMs - readMs) > PTT_LATE_EDGE_MS) {
    diagLog('ptt-late-edge', { key, heldMs, readMs });
  }
  if (active && !pttLocked && heldMs !== null && heldMs < PTT_TAP_MS) {
    pttLocked = true;
    diagLog('ptt-tap-lock', { key, heldMs, readMs });
    sendOverlay({ pttLocked: true });
    return;
  }
  requestPttStop();
}

// A watcher is born FREE while a push-to-talk recording of its key is still
// on when the key came up after the last watcher died and before this one was
// running: the restart's back-off plus the second or so PowerShell takes to
// compile the helper. Nothing else reports that release, so the recording ran
// until the next press. A locked dictation is not waiting for a release, and
// the FREE of a launch or a shortcut change has no recording to end.
function endPttMissedRelease(key) {
  if (!isPtt() || pttLocked || !pttRecordingOf(key)) return;
  diagLog('ptt-release-missed', { key, mode });
  requestPttStop();
}

function pttRecordingOf(key) {
  return pttOwner === key && (mode === 'arming' || mode === 'recording');
}

// One line from a key watcher. A clean or dirty release ends with the hold in
// milliseconds by the watcher's clock ("UP clean 1840"); the rest of the
// protocol is fixed words.
function watcherLine(line) {
  const timed = /^(UP \w+) (\d+)$/.exec(line);
  return timed ? { msg: timed[1], heldMs: Number(timed[2]) } : { msg: line, heldMs: null };
}

// A clean release can beat getUserMedia on a cold microphone. Remember it
// until capture-ready instead of turning a valid PTT press into Cancelled.
function requestPttStop() {
  if (mode === 'arming') {
    pttReleasePending = true;
    return;
  }
  requestStop();
}

async function cancelListen() {
  if (mode !== 'arming' && mode !== 'recording' && mode !== 'transcribing') return;
  recordingStartedAt = 0;
  lastDurationMs = 0;
  flashCancel();
}

// Only the latest dictation's editable field is observed, and its text stays
// in this short-lived session. The dictionary receives corrected terms only.
let correctionSession = null;
let autoLearnReceipt = null;
let autoLearnNotice = null;

function stopCorrectionLearning() {
  const previous = correctionSession;
  correctionSession = null;
  if (!previous) return;
  if (previous.tracker) previous.tracker.stop();
  previous.observer.stop();
}

// The watcher on the target field is a fresh powershell.exe with UI Automation
// in it, and it has to be ready before the paste so it can see the field as it
// was. Started at paste time it sat between transcript and paste and was most
// of the half second the paste took. So it is started the moment the recording
// stops: the target window is known by then, and the transcript takes longer
// than the watcher does to come up.
let correctionPrestart = null;

// Never for a game: the watcher is a fresh PowerShell and UI Automation
// started the moment the player stops talking, and a game's text box is not
// one UI Automation can read anyway.
function correctionLearningWanted() {
  return settings.autoAddToDictionary !== false && process.platform === 'win32'
    && !gameDictation && !isOurHwnd(String(lastHwnd));
}

function beginCorrectionObserver(hwnd) {
  const running = { observer: null, tracker: null, pasted: false, hwnd: String(hwnd), initial: null, baseline: null };
  running.observer = createCorrectionObserver({
    onSnapshot: snapshot => {
      if (correctionSession !== running) return;
      if (running.tracker) running.tracker.observe(snapshot);
      else running.baseline = snapshot;
    },
    onStop: (reason) => {
      running.stopReason = String(reason || 'stopped');
      if (correctionSession === running) stopCorrectionLearning();
    },
  });
  correctionSession = running;
  running.startedAt = Date.now();
  running.initial = running.observer.start({ hwnd: String(hwnd) }).then(initial => {
    if (correctionSession === running && initial && !running.baseline) running.baseline = initial;
    return initial;
  });
  return running;
}

// Why the paste did or did not get the early-started watcher, for the
// history entry. Diagnostics only; nothing here changes what happens.
let lastLearnPath = '';

function prestartCorrectionLearning() {
  correctionPrestart = null;
  if (!correctionLearningWanted()) return;
  stopCorrectionLearning();
  // The watcher reads the focused field of the foreground window, and a bar
  // that can take focus while it shows "transcribing" is neither. The paste
  // path makes the bar unfocusable for the same reason; do it here first,
  // or the early watcher gives up with "unsupported" and correction learning
  // is skipped for the clip.
  makeUnfocusable(overlayWin);
  correctionPrestart = { running: beginCorrectionObserver(lastHwnd), session: recordingSessionToken };
}

async function prepareCorrectionLearning(text) {
  const prestart = correctionPrestart;
  correctionPrestart = null;
  const reusable = !!(prestart && prestart.session === recordingSessionToken
    && prestart.running.hwnd === String(lastHwnd) && correctionSession === prestart.running);
  lastLearnPath = !prestart ? 'skipped:no-prestart'
    : prestart.session !== recordingSessionToken ? 'skipped:session-changed'
    : prestart.running.hwnd !== String(lastHwnd) ? 'skipped:hwnd-changed:' + prestart.running.hwnd + '>' + String(lastHwnd)
    : correctionSession !== prestart.running ? 'skipped:watcher-stopped:' + (prestart.running.stopReason || 'unknown')
    : 'reused:' + (Date.now() - prestart.running.startedAt) + 'ms-ago';
  if (!reusable) stopCorrectionLearning();
  if (!correctionLearningWanted()) {
    stopCorrectionLearning();
    return null;
  }
  // Use an existing pre-paste snapshot immediately. Starting or waiting for
  // a field watcher here delays ready text; a late baseline would also risk
  // mistaking our own paste for a correction.
  if (!reusable) return null;
  const running = prestart.running;
  const initial = running.baseline;
  if (!initial) {
    lastLearnPath += ':not-ready';
    stopCorrectionLearning();
    return null;
  }
  running.tracker = createCorrectionTracker({
    initial, text,
    onStop: () => { if (correctionSession === running) stopCorrectionLearning(); },
    onPairs: pairs => {
      if (correctionSession === running && running.pasted && settings.autoAddToDictionary !== false
          && ['idle', 'success', 'learned'].includes(mode)) addAutomaticCorrections(pairs);
    },
  });
  if (!running.tracker.active) { stopCorrectionLearning(); return null; }
  return running;
}

function dismissAutoLearnLater(ms = 8000) {
  if (successTimer) clearTimeout(successTimer);
  successTimer = setTimeout(() => {
    successTimer = null;
    if (mode !== 'learned') return;
    autoLearnNotice = null;
    autoLearnReceipt = null;
    mode = 'idle';
    sendOverlay({ mode: 'idle' });
  }, ms);
}

function showAutoLearnNotice(text, undoToken) {
  mode = 'learned';
  autoLearnNotice = { text, undoToken };
  overlayEditing = false;
  makeUnfocusable(overlayWin);
  showOverlay();
  sendOverlay({ mode: 'learned', text, undoToken, reveal: true });
  dismissAutoLearnLater(undoToken ? 8000 : 1800);
}

function addAutomaticCorrections(pairs) {
  const result = autoDictionary.addCorrections(dictionary, pairs);
  if (!result.added.length) return;
  const previous = dictionary;
  dictionary = result.dictionary;
  try { saveDict(); } catch (_) {
    dictionary = previous;
    vocabularyDirty = true;
    return;
  }
  const prior = mode === 'learned' && autoLearnReceipt ? autoLearnReceipt.added : [];
  autoLearnReceipt = { token: require('crypto').randomUUID(), added: prior.concat(result.added) };
  const added = autoLearnReceipt.added;
  const text = added.length === 1
    ? 'Added “' + added[0].to + '” to dictionary'
    : 'Added ' + added.length + ' words to dictionary';
  broadcast();
  showAutoLearnNotice(text, autoLearnReceipt.token);
}

ipcMain.handle('dict-auto-undo', async (e, token) => {
  if (!overlayWin || overlayWin.isDestroyed() || e.sender !== overlayWin.webContents) {
    return { ok: false, error: 'Open the flow bar to undo this addition.' };
  }
  if (!autoLearnReceipt || token !== autoLearnReceipt.token || mode !== 'learned') {
    return { ok: false, error: 'This Undo has expired. You can remove the word in Dictionary.' };
  }
  const result = autoDictionary.undoCorrections(dictionary, autoLearnReceipt.added);
  const previous = dictionary;
  dictionary = result.dictionary;
  try { saveDict(); } catch (_) {
    dictionary = previous;
    vocabularyDirty = true;
    return { ok: false, error: 'Could not undo the addition. Try again.' };
  }
  // Stop this observation so the unchanged correction cannot immediately
  // re-add a word the user just removed.
  stopCorrectionLearning();
  autoLearnReceipt = null;
  broadcast();
  showAutoLearnNotice(result.removed.length ? 'Dictionary addition undone' : 'Dictionary entry already changed', '');
  return { ok: true };
});

let clipboardPaste = null;
// Apps that run inside a virtual machine paste from a clipboard of their own,
// copied over from Windows' with a delay. Google Play Games (its Android VM is
// crosvm.exe) pasted the user's old copy instead of the dictation on
// 2026-10-02: Ctrl+V landed 10-45 ms after the write, before the copy, and the
// old copy went back 0.5 s later. Those pastes give the copy time to land and
// leave the dictation on the clipboard well after. Both values are untuned.
const VM_CLIPBOARD_EXES = new Set(['crosvm.exe']);
const VM_CLIPBOARD_TIMING = { settleMs: 300, restoreMs: 3000 };
function vmClipboardTarget(hwnd) {
  return String(lastTarget.hwnd) === String(hwnd)
    && VM_CLIPBOARD_EXES.has(String(lastTarget.exe || '').toLowerCase());
}

// `game`: the dictation was made with the game shortcut (see GAME_SHORTCUT_DEFAULT).
async function pasteText(text, { game = false, pasteLast = false } = {}) {
  const target = String(lastHwnd || '0');
  const session = recordingSessionToken;
  if (target !== '0' && target === historyHwnd) {
    const win = historyWin;
    if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) {
      throw new Error('Vell text field is no longer available');
    }
    // Native insertion preserves the field's selection, input events, undo,
    // and maxlength without borrowing the clipboard or sending OS paste keys.
    // A button or a closed dialog must not count as a successful paste.
    const editable = await win.webContents.executeJavaScript(`(() => {
      const field = document.activeElement;
      if (!field || field.matches(':disabled') || field.readOnly
          || field.closest('[inert]') || !field.getClientRects().length) return false;
      return field.tagName === 'TEXTAREA' || field.isContentEditable
        || (field.tagName === 'INPUT' && ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(field.type));
    })()`);
    if (session !== recordingSessionToken) throw new Error('Dictation cancelled');
    if (win !== historyWin || win.isDestroyed() || !win.isVisible() || win.isMinimized()) {
      throw new Error('Vell text field is no longer available');
    }
    if (!editable) throw new Error('Click a text field in Vell and try again');
    await win.webContents.insertText(text);
    return;
  }
  if (!clipboardPaste) clipboardPaste = createClipboardPaste(clipboard);
  return clipboardPaste.paste(text, async () => {
    if (session !== recordingSessionToken) throw new Error('Dictation cancelled');
    makeUnfocusable(overlayWin);
    // A dictation made with the game shortcut is pasted without fake key-ups,
    // and only while the game is still in front.
    const args = ['paste', '-Hwnd', target];
    if (game && process.platform === 'win32') args.push('-Mode', 'game');
    if (pasteLast && process.platform === 'win32') {
      const chord = hotkeys.encodeChordFor(process.platform, settings.pasteLastShortcut);
      if (chord) args.push('-Vks', chord);
    }
    const pasted = await ps(args);
    if (!String(pasted).split(/\r?\n/).includes('VELL_OK')) {
      // What came back goes in the error, for the flow bar log. Nothing at all
      // is a helper that timed out or died; win32.ps1 answers a failed paste
      // with its reason, a window that would not come forward among them.
      const answer = String(pasted);
      // An app run as administrator takes no simulated keys from Vell, but
      // takes the user's own: the words stay on the clipboard for them.
      if (/runs as administrator/.test(answer)) {
        const err = new Error('Paste helper failed: target runs as administrator');
        err.adminTarget = true;
        err.keepClipboard = true;
        throw err;
      }
      // Nor is a window pulled over a fullscreen game or film the user went
      // to while the words were on their way: they wait on the clipboard.
      if (/fullscreen app is in front/.test(answer)) {
        const err = new Error('Paste helper failed: a fullscreen app is in front');
        err.fullscreenInFront = true;
        err.keepClipboard = true;
        throw err;
      }
      // macOS posts Cmd+V through the helper, which the system allows only
      // for Accessibility-trusted binaries. Without the grant nothing can be
      // pasted for the user -- but the words are already on the clipboard,
      // and a real keypress needs no grant, so they stay there for the
      // user's own Cmd+V instead of being restored away half a second later.
      if (/Accessibility permission is missing/.test(answer)) {
        const err = new Error('Paste helper failed: Accessibility permission is missing');
        err.keepClipboard = true;
        throw err;
      }
      const why = !answer ? 'no answer'
        : /could not be focused/.test(answer) ? 'target could not be focused'
        : /no longer in front/.test(answer) ? 'game no longer in front'
        : 'answered ' + JSON.stringify(answer.slice(0, 40));
      throw new Error('Paste helper failed: ' + why);
    }
  }, vmClipboardTarget(target) ? VM_CLIPBOARD_TIMING : undefined);
}

function addHistoryEntry(text, meta) {
  const entry = {
    id: nid(),
    ts: Date.now(),
    text,
    original: meta && typeof meta.rawAsr === 'string' ? meta.rawAsr : text,
  };
  if (lastDurationMs > 0) entry.durationMs = lastDurationMs;
  if (meta) {
    if (meta.exe) entry.exe = meta.exe;
    // A window title has no length limit; the card shows one line of it, and
    // the dashboard's title parsing should never see a page-sized string.
    if (meta.title) entry.title = Array.from(String(meta.title).slice(0, 600)).slice(0, 300).join('');
    if (meta.category) entry.category = meta.category;
    if (typeof meta.dictionaryHits === 'number') entry.dictionaryHits = meta.dictionaryHits;
    if (typeof meta.styleFixes === 'number') entry.styleFixes = meta.styleFixes;
    const traceFields = [
      'rawAsr', 'afterCleanup', 'afterCorrections', 'afterDedupe', 'afterDictionary', 'afterAutoCleanup',
      'asrEngine', 'pasteLearnPath',
    ];
    for (const field of traceFields) {
      if (typeof meta[field] === 'string') entry[field] = meta[field];
    }
    // Whether this dictation paid a model (re)load. Only stored when true,
    // so warm transcriptions carry no extra fields.
    if (meta.coldStart === true) entry.coldStart = true;
    if (Number.isFinite(meta.loadMs) && meta.loadMs > 0) entry.loadMs = Math.round(meta.loadMs);
    // What a spoken correction took out, so it can always be seen again.
    if (Array.isArray(meta.spokenCorrections) && meta.spokenCorrections.length) {
      entry.spokenCorrections = meta.spokenCorrections.slice();
    }
    const timingFields = [
      'recognitionMs', 'modelRecognitionMs', 'pasteMs',
      'postProcessMs', 'stopToPasteMs', 'pasteLearnMs', 'pasteHelperMs',
      'armMs', 'armCueMs', 'armMediaMs', 'armMicMs', 'armHoldMs',
    ];
    for (const field of timingFields) {
      if (Number.isFinite(meta[field]) && meta[field] >= 0) entry[field] = Math.round(meta[field]);
    }
    // What the vocabulary did to this dictation: which engine ran, whether the
    // terms reached the model or were applied afterwards, how much of the
    // dictionary fitted, and every repair that was made or declined.
    //
    // Everything here is either a number or a term the user typed in
    // themselves. No audio, no clipboard, no window text, nothing from the
    // context features -- this record is safe to keep whatever the privacy
    // settings say, which is the point of writing it this way.
    if (meta.vocabulary && typeof meta.vocabulary === 'object') {
      entry.vocabulary = meta.vocabulary;
    }
  }
  lastDurationMs = 0;
  saveHistory({ ...history, entries: [entry, ...history.entries] });
  retryEntryOwner = entry.id;
  if (keepingClips()) {
    corpus.claim(entry.id);
    pruneRecordings();
  } else {
    corpus.dropParked();
  }
  broadcast();
  return entry;
}

// Every dictation path ends the same way. Keeping the tail in one place is
// what stops the verbatim path from drifting away from the styled one.
// Where the paste's time went, for the history entry: waiting for the field
// watcher, and the clipboard-and-keystroke helper itself.
let lastPasteBreakdown = null;

async function pasteDictation(text) {
  const startedAt = Date.now();
  makeUnfocusable(overlayWin);
  const session = recordingSessionToken;
  const learning = await prepareCorrectionLearning(text);
  const learnedAt = Date.now();
  if (session !== recordingSessionToken) {
    if (learning && correctionSession === learning) stopCorrectionLearning();
    throw new Error('Dictation cancelled');
  }
  try { await pasteText(text, { game: gameDictation }); } catch (err) {
    if (learning && correctionSession === learning) stopCorrectionLearning();
    throw err;
  }
  if (learning && correctionSession === learning) learning.pasted = true;
  const finishedAt = Date.now();
  lastPasteBreakdown = { pasteLearnMs: learnedAt - startedAt, pasteHelperMs: finishedAt - learnedAt, pasteLearnPath: lastLearnPath };
  metrics.markPasteComplete(dictationTiming, startedAt, finishedAt);
}

function finishDictation(text, meta) {
  mode = 'success';
  const timedMeta = Object.assign({}, meta || {}, metrics.dictationTimingFields(dictationTiming),
    metrics.armTimingFields(armTiming), lastPasteBreakdown || {});
  lastPasteBreakdown = null;
  const entry = addHistoryEntry(text, timedMeta);
  dictationTiming = null;
  armTiming = null;
  sendOverlay({ mode: 'success', text, entryId: entry.id });
  registerEscape(false);
  resumeBackgroundMedia();
  endSuccessAfter(corpus.hasRetry() ? 4000 : 1600);
  return entry;
}

function endSuccessAfter(ms) {
  if (successTimer) clearTimeout(successTimer);
  successTimer = setTimeout(() => {
    successTimer = null;
    mode = 'idle';
    sendOverlay({ mode: 'idle' });
  }, ms);
}

// --- Polish ------------------------------------------------------------------
// Apply the user's vocabulary to a finished transcript.
//
// Two stages, deliberately kept apart:
//
//   1. explicit replacement -- the rules the user wrote, matched exactly, in
//      any script. No judgement, so it runs on every path including verbatim.
//   2. acoustic repair -- deciding that a span the engine produced is a
//      mangled vocabulary term. This is a judgement, so it only fires on the
//      evidence src/repair.js requires: identical letters, or a span the
//      decoder itself flagged as uncertain.
//
// Anything repair wanted to do but could not justify comes back as an
// escalation: a term worth rechecking against the audio on an engine that can
// be told about it. The caller decides whether that recheck is worth its
// latency.
function applyVocabulary(text, options) {
  const opts = options || {};
  const language = opts.language || textLanguage();
  const entries = vocabularyForDictation(language);
  if (!entries.length || !String(text || '').trim()) {
    return { text: String(text || ''), hits: 0, applied: [], repairs: [], escalate: [], entries };
  }
  const replaced = vocabulary.applyEntries(text, entries, { language });
  if (opts.replacementsOnly) {
    return Object.assign({ repairs: [], escalate: [], entries }, replaced);
  }
  const repaired = repair.repairTranscript(replaced.text, entries, {
    language,
    segments: opts.segments,
  });
  return {
    text: repaired.text,
    hits: replaced.hits,
    applied: replaced.applied,
    repairs: repaired.repairs,
    escalate: repaired.escalate,
    entries,
  };
}

// Mark the terms a finished dictation actually used, so ranking learns what is
// current. Written through saveDict, which also rebuilds the ranked view.
function recordVocabularyUse(text, entries) {
  const used = vocabulary.usedEntries(text, entries || []);
  if (!used.length) return;
  storedVocabularyEntries = vocabulary.touch(currentVocabulary(), used);
  vocabularyDirty = true;
  try {
    vocabulary.saveState(DICT_FILE, {
      phrases: dictionary.phrases,
      variants: dictionary.variants,
      pending: dictionary.pending,
      blocked: dictionary.blocked,
      entries: storedVocabularyEntries,
    });
  } catch (_) {}
}

function vocabularyViaFromReports(asrReport, report) {
  const actual = String((asrReport && asrReport.vocabulary) || '');
  if (actual === 'context' || actual === 'initial_prompt') return actual;
  if (actual === 'unsupported') return (report && report.offered) ? 'repair' : 'none';
  if ((report && report.via) === 'repair' && (report.offered || 0) > 0) return 'repair';
  return actual || (report && report.via) || 'none';
}

// One line the user can read about what just happened to their words.
function vocabularyDiagnostics(result) {
  const report = lastVocabularyReport || {};
  const asrReport = lastAsrReport || {};
  const via = vocabularyViaFromReports(asrReport, report);
  const actualEngine = asrReport.engine || report.engine || '';
  const plan = {
    engine: actualEngine || report.engine,
    vocabularyVia: via,
    reason: report.reason || '',
    degraded: !!report.degraded,
    lostCapabilities: report.lostCapabilities || [],
  };
  return {
    selectedEngine: report.selectedEngine || 'voz',
    selectedDevice: report.selectedDevice || 'cpu',
    engine: actualEngine,
    device: asrReport.device || report.device || 'cpu',
    backend: asrReport.backend || report.backend || 'cpu',
    gpuName: '',
    gpuArch: '',
    driverVersion: '',
    torchVersion: '',
    packId: '',
    computeType: '',
    probePassed: false,
    initPassed: false,
    fallbackReason: asrReport.fallbackReason || report.fallbackReason || '',
    sidecarWarning: '',
    audioSec: asrReport.audioSec || 0,
    recognitionSec: asrReport.recognitionSec || 0,
    rtf: asrReport.rtf || 0,
    language: report.language || '',
    vocabularyVia: via,
    vocabularyMechanism: asrReport.vocabulary || report.mechanism || '',
    termsOffered: report.offered || 0,
    termsSent: report.sent || 0,
    termsDropped: report.dropped || 0,
    droppedTerms: report.droppedTerms || [],
    promptTokens: report.tokens || 0,
    uncertainSpans: (asrReport.segments || []).length,
    dictionaryHits: (result && result.hits) || 0,
    repairs: ((result && result.repairs) || []).map((r) => ({
      heard: r.heard, term: r.term, reason: r.reason,
    })),
    rejectedRepairs: ((result && result.escalate) || []).map((r) => ({
      heard: r.heard, term: r.term,
    })),
    escalations: ((result && result.escalate) || []).map((r) => ({
      heard: r.heard, term: r.term,
    })),
    reason: report.reason || '',
    fallbackFrom: report.fallbackFrom || '',
    summary: capabilities.summarizeRoute(plan, {}),
  };
}

// Everything that happens to a transcript between the engine and the paste:
// spoken commands, numbers, repeats, dictionary, optional proofreading, tone --
// or the verbatim rules instead. Shared by a live dictation and a retry from
// the history page, so a retried transcript is exactly what that dictation
// would have pasted. Returns an empty text when there was no speech.
// Local-only: the transcript is worked over on this PC by rules --
function composeTranscript(raw, tone) {
  const engine = (lastAsrReport && lastAsrReport.engine)
    || (lastVocabularyReport && lastVocabularyReport.engine)
    || asrEngineFor();
  // Every engine writes what it hears; Voz has no Hindi, so there is no
  // script to romanize. The raw transcript is kept as the engine gave it.
  const said = raw;
  const spoken = said;

  // Verbatim pastes what was said. Repeat collapsing and the tone's filler
  // removal both take words out, so neither runs.
  // The dictionary is the one stage that can stay: it corrects spellings the
  // engine got wrong rather than words the speaker chose, so it is opt-in.
  if (settings.verbatimMode) {
    const verbatim = cleanupVerbatim(spoken);
    // Verbatim pastes what was said, so only the explicit rules run. Acoustic
    // repair is a guess about what the speaker meant, and a mode whose whole
    // promise is "your exact words" is the wrong place for a guess.
    const verbatimDict = settings.verbatimDictionary
      ? applyVocabulary(verbatim, { replacementsOnly: true })
      : { text: verbatim, hits: 0, entries: [] };
    return {
      text: verbatimDict.text,
      entries: verbatimDict.entries,
      meta: {
        dictionaryHits: verbatimDict.hits || 0,
        styleFixes: 0,
        rawAsr: String(raw || '').trim(),
        afterCleanup: verbatim,
        afterDictionary: verbatimDict.text,
        asrEngine: engine,
        vocabulary: vocabularyDiagnostics(verbatimDict),
      },
    };
  }

  // Numbers after the commands and before the dictionary: "insert period"
  // must not be read as a decimal point, and a dictionary term can contain a
  // figure the user typed as a figure.
  const language = textLanguage();
  const cleaned = settings.numbersAsDigits !== false && /^en(?:-|$)/i.test(language)
    ? spokenNumbersToDigits(cleanup(spoken, language))
    : cleanup(spoken, language);
  // What the speaker took back ("on the field, no, in the park"), when they
  // turned that on. After the numbers, so "three, no, four" is a number for a
  // number; before the dictionary and the repeat collapser, which should only
  // ever see the words that are staying. Its cue words are English ones.
  const corrections = settings.spokenCorrections === true && spokenCorrectionsAvailable()
    && /^en(?:-|$)/i.test(language)
    ? applySpokenCorrections(cleaned)
    : { text: cleaned, removed: [] };
  // A dictionary term reaches the dictionary whole: "Bora Bora" must not
  // lose a word to the repeat collapser before the dictionary spells it.
  const spokenTerms = vocabularyForDictation(language)
    .flatMap(entry => [entry.canonical, ...(entry.aliases || [])]);
  const deduped = dedupeRepeats(corrections.text, spokenTerms);
  const dictResult = applyVocabulary(deduped, {
    segments: lastAsrReport && lastAsrReport.segments,
  });
  const text = dictResult.text;
  const canonicals = dictResult.entries.map(entry => entry.canonical);
  const proofread = settings.autoCleanup === true
    ? autoCleanup(text, { language, protectedTerms: canonicals })
    : text;
  const styled = proofread
    ? dedupeRepeats(style.applyStyleWithTone(proofread, tone, language, canonicals), canonicals)
    : '';
  return {
    text: styled,
    entries: dictResult.entries,
    meta: {
      dictionaryHits: dictResult.hits || 0,
      styleFixes: insights.wordDiffCount(raw, deduped) + insights.wordDiffCount(text, styled),
      rawAsr: String(raw || '').trim(),
      afterCleanup: cleaned,
      // Only when something was taken out: the words, cue included.
      ...(corrections.removed.length
        ? { afterCorrections: corrections.text, spokenCorrections: corrections.removed.slice() }
        : {}),
      afterDedupe: deduped,
      afterDictionary: text,
      afterAutoCleanup: proofread,
      asrEngine: engine,
      // Whether this dictation paid a model (re)load, and how long the load
      // took. Stored on the history entry so a slow transcription explains
      // itself in the stats instead of looking like slow inference.
      ...(lastAsrReport && lastAsrReport.coldStart ? { coldStart: true } : {}),
      ...(lastAsrReport && Number(lastAsrReport.loadMs) > 0
        ? { loadMs: Math.round(Number(lastAsrReport.loadMs)) }
        : {}),
      vocabulary: vocabularyDiagnostics(dictResult),
    },
  };
}

async function onTranscript(raw, sessionToken = recordingSessionToken) {
  if (sessionToken !== recordingSessionToken) return;
  metrics.markRecognitionComplete(
    dictationTiming,
    Date.now(),
    lastAsrReport && lastAsrReport.modelRecognitionMs
  );
  const category = style.classifyTarget(lastTarget.exe, lastTarget.title);
  const tone = style.toneForCategory(category, settings.writingStyles);
  if (sessionToken !== recordingSessionToken) return;
  const composeStarted = Date.now();
  const composed = composeTranscript(raw, tone);
  diagLog('text-processing', { ms: Date.now() - composeStarted, characters: String(raw || '').length });
  if (!composed.text) {
    flashError('No speech');
    return;
  }
  try {
    await pasteDictation(composed.text);
  } catch (err) {
    if (sessionToken !== recordingSessionToken) return;
    // Why, for the flow bar log: the error and the app, never the words or the
    // window title, which can name a document. Formats are names only.
    const reason = String((err && err.message) || err).slice(0, 80);
    const failure = { reason, exe: lastTarget.exe || '' };
    if (/cannot be safely restored/.test(reason)) failure.formats = clipboard.availableFormats();
    // On a Mac the usual reason is a missing Accessibility grant, and that one
    // is named, with the system prompt that leads to it, rather than left for
    // the user to guess from every dictation failing the same way.
    const needsAccess = macShell.pasteNeedsAccessibility(require('electron').systemPreferences, process.platform);
    if (needsAccess) failure.accessibility = false;
    diagLog('paste-failed', failure);
    addHistoryEntry(composed.text, composed.meta);
    const admin = !!(err && err.adminTarget);
    if (admin) noteAdminApp(lastTarget.exe);
    // Name the binary that needs the grant: in a dev launch that is Electron,
    // not Vell. The words stay on the clipboard (keepClipboard), so a real
    // keypress -- which needs no grant -- still pastes them.
    const trustedName = (process.execPath ? path.basename(process.execPath).replace(/\.exe$/i, '') : '') || 'Vell';
    flashError(needsAccess ? 'Allow ' + trustedName + ' in Accessibility to paste — text is on the clipboard'
      : admin ? ADMIN_PASTE_FLASH
      : err && err.fullscreenInFront ? FULLSCREEN_PASTE_FLASH
      : 'Paste failed — text saved in history');
    return;
  }
  if (sessionToken !== recordingSessionToken) return;
  finishDictation(composed.text, Object.assign({
    exe: lastTarget.exe || '',
    title: lastTarget.title || '',
    category,
  }, composed.meta));
  recordVocabularyUse(composed.text, composed.entries);
}

// Run a kept recording through the engine again and replace the transcript.
// The text gets everything the live dictation did to it, with the tone the
// entry was pasted with; only the paste is skipped. Not while a dictation is
// in flight: the engine is one queue, and the overlay is telling a story
// about a different clip.
let retryingEntryId = null;
let retryEntryOwner = null;
let recordingsError = '';
let trainingError = '';

function transcriptionTimeout(seconds) {
  return Math.max(60000, Math.round(20000 + Math.max(0, Number(seconds) || 0) * 8000));
}

async function retryEntry(id) {
  if (mode === 'arming' || mode === 'recording' || mode === 'transcribing') {
    return { ok: false, reason: 'Finish the current dictation first.' };
  }
  if (retryingEntryId) return { ok: false, reason: 'Another retry is still running.' };
  const entry = history.entries.find((x) => x.id === id);
  if (!entry) return { ok: false, reason: 'That dictation is no longer in history.' };
  const file = corpus.recordingPath(entry.id);
  if (!file) return { ok: false, reason: 'No recording kept for this dictation.' };
  retryingEntryId = entry.id;
  const revision = entry.editRevision || 0;
  const beforeText = entry.text;
  try {
    const raw = await transcribeSavedFile(file);
    const currentEntry = history.entries.find(item => item.id === id);
    if (!currentEntry) return { ok: false, reason: 'That dictation was deleted.' };
    if (currentEntry !== entry || (currentEntry.editRevision || 0) !== revision || currentEntry.text !== beforeText) {
      return { ok: false, reason: 'Your newer correction was kept. Retry again if needed.' };
    }
    const category = entry.category || style.classifyTarget(entry.exe, entry.title);
    const tone = style.toneForCategory(category, settings.writingStyles);
    const composed = composeTranscript(raw, tone);
    if (!composed.text) return { ok: false, reason: 'The engine heard no speech in this recording.' };
    const changed = composed.text !== entry.text;
    const updated = { ...entry };
    if (changed) {
      // The previous words are kept, not for undo but so an edit after the
      // retry still proposes dictionary pairs against what the engine heard.
      updated.previousText = entry.text;
      updated.text = composed.text;
      updated.learnedPairs = [];
    }
    updated.original = composed.meta.rawAsr;
    updated.retriedTs = Date.now();
    for (const field of ['asrEngine', 'afterCleanup', 'afterDedupe', 'afterDictionary', 'afterAutoCleanup']) {
      if (typeof composed.meta[field] === 'string') updated[field] = composed.meta[field];
    }
    // A retry decides corrections afresh: the setting may have changed since.
    delete updated.afterCorrections;
    delete updated.spokenCorrections;
    if (composed.meta.spokenCorrections) {
      updated.afterCorrections = composed.meta.afterCorrections;
      updated.spokenCorrections = composed.meta.spokenCorrections.slice();
    }
    saveHistory({ ...history, entries: history.entries.map(item => item === entry ? updated : item) });
    broadcast();
    return { ok: true, changed, text: composed.text, engine: composed.meta.asrEngine };
  } catch (err) {
    return { ok: false, reason: friendlyEngineError((err && err.message) || 'Retry failed') };
  } finally {
    retryingEntryId = null;
  }
}

// Turn a shelved clip into the dictation it never became, with the local
// engine the user has selected now.
//
// The words are not pasted: the window this was dictated into is long gone.
// They go to history and to the clipboard, where the user can put them
// wherever they were actually headed.
let recoveringId = null;

async function recoverRecording(id) {
  if (mode === 'arming' || mode === 'recording' || mode === 'transcribing') {
    return { ok: false, reason: 'Finish the current dictation first.' };
  }
  if (retryingEntryId || recoveringId) return { ok: false, reason: 'Another recovery is still running.' };
  const item = corpus.recoveries().find((r) => r.id === id);
  const file = item ? corpus.recoveryPath(id) : null;
  if (!file) return { ok: false, reason: 'That recording is no longer here.' };
  recoveringId = id;
  try {
    const raw = await transcribeSavedFile(file);
    const category = style.classifyTarget(item.exe, item.title);
    const tone = style.toneForCategory(category, settings.writingStyles);
    const composed = composeTranscript(raw, tone);
    // Nothing heard is not a reason to destroy the evidence: the clip stays
    // shelved so the user can play it, save it, or try a different engine.
    if (!composed.text) return { ok: false, reason: 'The engine heard no speech in this recording.' };
    // No dictation is in flight, so nothing legitimate is parked. Clear the
    // slot rather than let a stale clip be claimed by this entry.
    corpus.dropParked();
    lastDurationMs = Math.round(Math.max(0, Number(item.seconds) || 0) * 1000);
    const entry = addHistoryEntry(composed.text, Object.assign({
      exe: item.exe || '',
      title: item.title || '',
      category,
    }, composed.meta));
    // The clip belongs to its entry now: playable, savable, retryable, and a
    // training pair the moment the user corrects it.
    corpus.adoptRecovery(id, entry.id);
    clipboard.writeText(composed.text);
    broadcast();
    return { ok: true, text: composed.text, entryId: entry.id };
  } catch (err) {
    return { ok: false, reason: friendlyEngineError((err && err.message) || 'Recovery failed') };
  } finally {
    recoveringId = null;
  }
}

async function retryLast() {
  if (mode === 'arming' || mode === 'recording' || mode === 'transcribing') return;
  if (retryingEntryId) return;
  if (!keepingClips()) { flashError('Recording retention is off'); return; }
  const file = corpus.retryPath();
  if (!file) {
    flashError('Nothing to retry');
    return;
  }
  stopCorrectionLearning();
  if (successTimer) clearTimeout(successTimer);
  const sessionToken = advanceRecordingSession();
  dictationTiming = metrics.beginDictationTiming(Date.now());
  armTiming = null;
  mode = 'transcribing';
  showOverlay();
  sendOverlay({ mode: 'transcribing', reveal: true });
  registerEscape(true);
  try {
    prestartCorrectionLearning();
    const text = await transcribeSavedFile(file);
    if (sessionToken !== recordingSessionToken || mode !== 'transcribing') return;
    await onTranscript(text, sessionToken);
  } catch (err) {
    if (sessionToken !== recordingSessionToken || mode !== 'transcribing') return;
    flashError(friendlyEngineError((err && err.message) || 'Retry failed'));
  }
}

function flashError(msg) {
  clearArmingTimer();
  stopCorrectionLearning();
  pttReleasePending = false;
  pttLocked = false;
  // This dictation produced no entry, so its clip has nothing to be labelled
  // with. Drop it rather than leave it for the next entry to claim -- but keep
  // the audio itself on the recovery shelf first, because the words in it are
  // the only copy the user has left.
  corpus.dropParked();
  const shelved = keepFailedClip(msg);
  endLiveClip();
  if (shelved) broadcast();
  registerEscape(false);
  recordingStartedAt = 0;
  lastDurationMs = 0;
  dictationTiming = null;
  armTiming = null;
  mode = 'error';
  resumeBackgroundMedia();
  showOverlay();
  makeUnfocusable(overlayWin);
  // The bar is gone in under two seconds, so if the audio was kept it has to
  // say so here -- otherwise the user's only signal is that their words
  // vanished, and they never think to look on the Dictation page.
  sendOverlay({ mode: 'error', text: shelved ? msg + ' · saved to recover' : msg });
  if (successTimer) clearTimeout(successTimer);
  successTimer = setTimeout(() => {
    mode = 'idle';
    sendOverlay({ mode: 'idle' });
  }, 1800);
}

// Escape and the overlay's X are deliberate. They tear down the same way a
// failure does, but they are not failures -- reporting one as "Transcription
// failed" told the user their dictation broke when they were the one who
// stopped it.
function flashCancel() {
  stopCorrectionLearning();
  advanceRecordingSession();
  clearArmingTimer();
  pttReleasePending = false;
  pttLocked = false;
  corpus.dropParked();
  endLiveClip();
  registerEscape(false);
  recordingStartedAt = 0;
  lastDurationMs = 0;
  dictationTiming = null;
  armTiming = null;
  mode = 'cancel';
  resumeBackgroundMedia();
  showOverlay();
  makeUnfocusable(overlayWin);
  sendOverlay({ mode: 'cancel', text: 'Cancelled' });
  if (successTimer) clearTimeout(successTimer);
  successTimer = setTimeout(() => {
    mode = 'idle';
    sendOverlay({ mode: 'idle' });
  }, 1200);
}

function toggleListen() {
  if (mode === 'idle' || mode === 'success' || mode === 'error' || mode === 'learned' || mode === 'cancel') {
    startRecording(false);
  } else if (mode === 'arming' || mode === 'recording') {
    requestStop();
  }
}

function registerEscape(on) {
  try { globalShortcut.unregister('Escape'); } catch (_) {}
  if (on) {
    globalShortcut.register('Escape', () => cancelListen());
  }
}

// --- Foreground window ------------------------------------------------------
// The paste target is whichever window was in front before the dictation
// started. It used to be read by starting a new powershell.exe every 500 ms,
// and each of those compiled the Win32 helper class before answering -- about
// a quarter of a CPU second per poll, twice a second, for as long as the app
// ran. That was the single largest idle cost of the app, and on a busy machine
// each poll took longer than the interval, so a helper process was alive
// essentially all the time. One long-lived watcher that only writes a line
// when the foreground window changes replaces it, in the same shape as the
// push-to-talk chord watcher.
//
// Two values are kept: what is in front right now, and what the text is owed
// to. They differ during a dictation, when the user may click around while
// speaking -- the transcript still goes to the window that had focus when the
// recording started.
let foregroundHwnd = '0';
let foregroundWatch = null;
let foregroundWatchRestartTimer = null;
let foregroundWatchRestartDelay = 250;
// Fallback when the watcher cannot be started at all: a slow spawn poll, so a
// broken PowerShell still leaves dictation working, just at a leisurely pace.
let foregroundFallbackTimer = null;
let foregroundFallbackBusy = false;

const FOREGROUND_FALLBACK_MS = 2000;
const HWND_TICK_MS = 1000;

// Whether the window in front is one of Windows' passing surfaces (" shell").
let foregroundIsShell = false;

function adoptForegroundHwnd(hwnd) {
  if (!isDictationTarget(hwnd)) return;
  foregroundHwnd = hwnd;
  // Reading the foreground window mid-dictation would replace the window the
  // text is owed to with whatever the user clicked on since.
  if (mode === 'arming' || mode === 'recording' || mode === 'transcribing') return;
  if (!isOurHwnd(hwnd)) lastExternalHwnd = hwnd;
  if (hwnd !== lastHwnd) {
    lastHwnd = hwnd;
    // A different app is in front, which is the only moment something can
    // have taken the topmost slot away from the bar. Not over Windows' own
    // passing surfaces: a taskbar list or Start opens where the bar sits, and
    // a bar raised over it covers what the user came to click.
    if (!foregroundIsShell) raiseOverlay();
  }
}

// A window the watcher marked as running above Vell (" admin"). Its app is
// looked up once per window, and the bell explains, once per app (the note's
// id). Never while Vell runs as administrator itself; a mark that arrives
// before the helper has said whether it does waits for that answer. Windows'
// own programs, Task Manager among them, are never marked: only a paste they
// actually refuse brings their note.
const adminWindowsNoted = new Set();
function noteAdminForeground(hwnd) {
  if (runningAsAdmin === true || adminWindowsNoted.has(hwnd)) return;
  if (runningAsAdmin === null && elevationCheck) {
    elevationCheck.then(() => noteAdminForeground(hwnd));
    return;
  }
  adminWindowsNoted.add(hwnd);
  winInfo(hwnd).then((info) => noteAdminApp(info.exe), () => {});
}

function launchForegroundWatch() {
  let proc;
  const cmd = helperCommand(['-Action', 'foreground-watch']);
  try {
    proc = spawn(cmd.file, cmd.args, { windowsHide: true });
  } catch (_) {
    return false;
  }
  foregroundWatch = proc;
  let buf = '';
  proc.stdout.on('data', (chunk) => {
    if (foregroundWatch !== proc) return;
    foregroundWatchRestartDelay = 250;
    buf += String(chunk);
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() || '';
    for (const line of lines) {
      const seen = /^(\d+)(?: fullscreen (-?\d+),(-?\d+),(-?\d+),(-?\d+))?( admin)?( shell)?$/.exec(line.trim());
      if (!seen) continue;
      foregroundIsShell = !!seen[7];
      if (!foregroundIsShell) {
        foregroundFillsMonitor = seen[2] === undefined ? null : {
          x: Number(seen[2]),
          y: Number(seen[3]),
          width: Number(seen[4]) - Number(seen[2]),
          height: Number(seen[5]) - Number(seen[3]),
        };
        setForegroundFullscreen(fullscreenUnderBar());
      }
      adoptForegroundHwnd(seen[1]);
      // An app run as administrator earns the note only when it fills its
      // screen -- a game, where the shortcut cannot reach Vell and nothing
      // else would say why. Any other gets one if a paste is refused.
      if (seen[6] && seen[2] !== undefined) noteAdminForeground(seen[1]);
    }
  });
  proc.stderr.on('data', () => {});
  const lost = () => {
    if (foregroundWatch !== proc) return;
    foregroundWatch = null;
    // Nothing reports fullscreen until a watcher is back, and a bar left
    // standing aside for a game long gone would never come back.
    foregroundFillsMonitor = null;
    foregroundIsShell = false;
    setForegroundFullscreen(false);
    scheduleForegroundWatchRestart();
  };
  proc.on('error', lost);
  proc.on('exit', lost);
  return true;
}

function scheduleForegroundWatchRestart() {
  if (isQuitting || foregroundWatchRestartTimer) return;
  const delay = foregroundWatchRestartDelay;
  foregroundWatchRestartDelay = Math.min(10000, foregroundWatchRestartDelay * 2);
  foregroundWatchRestartTimer = setTimeout(() => {
    foregroundWatchRestartTimer = null;
    if (isQuitting || foregroundWatch) return;
    if (!launchForegroundWatch()) scheduleForegroundWatchRestart();
  }, delay);
}

function stopForegroundWatch() {
  if (foregroundWatchRestartTimer) {
    clearTimeout(foregroundWatchRestartTimer);
    foregroundWatchRestartTimer = null;
  }
  if (foregroundFallbackTimer) {
    clearInterval(foregroundFallbackTimer);
    foregroundFallbackTimer = null;
  }
  if (foregroundWatch) {
    const proc = foregroundWatch;
    foregroundWatch = null;
    try { proc.kill(); } catch (_) {}
  }
}

async function foregroundFallbackTick() {
  // Only while the watcher is down. PowerShell startup can exceed the
  // interval on a busy machine, so never stack a second process on the first.
  if (foregroundWatch || foregroundFallbackBusy || isQuitting) return;
  if (mode === 'arming' || mode === 'recording' || mode === 'transcribing') return;
  foregroundFallbackBusy = true;
  try {
    adoptForegroundHwnd(await ps(['get']));
  } finally {
    foregroundFallbackBusy = false;
  }
}

function startHwndPoll() {
  if (hwndTimer) clearInterval(hwndTimer);
  stopForegroundWatch();
  if (!launchForegroundWatch()) scheduleForegroundWatchRestart();
  foregroundFallbackTimer = setInterval(foregroundFallbackTick, FOREGROUND_FALLBACK_MS);
  // In-process only: nothing here starts a process. The bar can go missing
  // while a dictation is nowhere near, so its health check runs on every tick,
  // and a foreground change that arrived during a dictation is adopted as the
  // next paste target once the dictation is over.
  hwndTimer = setInterval(() => {
    overlayHealthTick(Date.now());
    ensureOverlayVisible();
    if (mode === 'arming' || mode === 'recording' || mode === 'transcribing') return;
    if (foregroundHwnd !== '0' && foregroundHwnd !== lastHwnd) adoptForegroundHwnd(foregroundHwnd);
  }, HWND_TICK_MS);
}

// --- Voz lifecycle -----------------------------------------------------------
// There is no sidecar process anymore: Voz runs in-process through
// onnxruntime-node, loaded once and reused. "Ready" means the model bundle is
// on disk; the first transcription of the session compiles it (~10s, then
// warm). The state machine below keeps the old shape (states, waiters,
// broadcasts) so the overlay, tray and banner keep working unchanged.

// The provider is already warm and serving transcriptions.
function restartSidecar() {
  if (!vozModelManager || !vozModelManager.installed()) return;
  ensureVozReady().catch(() => {});
}

// Nothing external to stop: transcription runs in this process.
function stopPythonProcesses() {
  sidecarReadyWaiters.forEach((waiter) => {
    try { clearTimeout(waiter.timer); } catch (_) {}
    try { waiter.reject(new Error('speech engine not ready')); } catch (_) {}
  });
  sidecarReadyWaiters = [];
  sidecarReady = false;
  sidecarBuf = '';
  sidecarProgressBuf = '';
  return Promise.resolve();
}

function setSidecarState(state) {
  sidecarState = state;
  if (state === 'ready') finishSidecarWaiters(null);
  sendOverlay();
  broadcast();
}

function finishSidecarWaiters(err) {
  const list = sidecarReadyWaiters;
  sidecarReadyWaiters = [];
  for (const waiter of list) {
    clearTimeout(waiter.timer);
    if (err) waiter.reject(err);
    else waiter.resolve();
  }
}

function sidecarMayBecomeReady() {
  return sidecarState === 'standby'
    || sidecarState === 'starting'
    || sidecarState === 'loading';
}

// Warm the provider in the background once the model is on disk, so the first
// dictation does not pay the compile cost with the microphone already open.
// Fire and forget: a failure surfaces on first transcribe instead.
let vozWarmStarted = false;
// True while the Voz weights are resident in this process (~1GB). Tracks the
// shared loader in transcription-provider.js; cleared by unloadIdleModel.
let vozLoaded = false;
let modelUnloadTimer = null;
function clearModelUnload() {
  if (modelUnloadTimer) clearTimeout(modelUnloadTimer);
  modelUnloadTimer = null;
}
function scheduleModelUnload() {
  clearModelUnload();
  const mins = normalizeModelUnloadMinutes(settings.modelUnloadMinutes);
  if (!mins || mins <= 0 || isQuitting) return;
  modelUnloadTimer = setTimeout(() => {
    unloadIdleModel().catch(() => {});
  }, mins * 60 * 1000);
  if (modelUnloadTimer.unref) modelUnloadTimer.unref();
}
function markModelUsed() {
  vozLoaded = true;
  scheduleModelUnload();
}
// Drop the weights after X idle minutes. A dictation in flight reschedules
// instead of unloading; the next dictation reloads (~1-2s) via ensureVoz.
async function unloadIdleModel() {
  modelUnloadTimer = null;
  if (isQuitting) return;
  if (mode === 'arming' || mode === 'recording' || mode === 'transcribing') {
    scheduleModelUnload();
    return;
  }
  try {
    const { dropVoz } = require('./transcription-provider');
    await dropVoz();
  } catch (_) {}
  vozProviderInstance = null;
  vozLoaded = false;
  vozWarmStarted = false;
  broadcast();
}
function scheduleSidecarWarmStart() {
  if (vozWarmStarted || isQuitting) return;
  if (!vozModelManager || !vozModelManager.installed()) return;
  vozWarmStarted = true;
  ensureVozReady().catch(() => { vozWarmStarted = false; });
}

function clearSidecarLaunchPlan() {}

function requestSidecarStart() {
  if (sidecarState !== 'starting' && sidecarState !== 'standby') return;
  startSidecar();
}

function waitForSidecarReady(timeoutMs) {
  if (vozModelManager && vozModelManager.installed()) return Promise.resolve();
  return Promise.reject(new Error('The Voz model is not installed. Download it in Settings, Speech engines.'));
}

function startSidecar() {
  if (isQuitting || asrOperation) return;
  if (vozModelManager && vozModelManager.installed()) {
    setSidecarState('ready');
    scheduleSidecarWarmStart();
    return;
  }
  setSidecarState('unavailable');
}

function friendlyEngineError(msg) {
  // Electron prefixes rejected invoke() messages before the renderer sends
  // them back as capture failures. Remove that wrapper before judging their
  // length, so a useful engine error does not become "Transcribe failed".
  const m = String(msg || '').trim()
    .replace(/^Error invoking remote method ['"][^'"]+['"]:\s*(?:Error:\s*)?/i, '')
    .replace(/^Error:\s*/i, '');
  if (/charmap|codec can't encode|character maps/i.test(m)) return "Couldn't send transcript — try again";
  if (/speech engine timeout|whisper timeout/i.test(m)) return 'Transcription timed out';
  if (/speech engine not ready|whisper not ready|sidecar exited/i.test(m)) return 'Speech engine not ready';
  if (/Parakeet.*(?:does not support|recognises English only)/i.test(m)) return 'Unsupported language — check Speech settings';
  if (m.length > 56) return 'Transcribe failed';
  return m || 'Transcribe failed';
}

function parkCompletedClip(buf) {
  if (!buf || !buf.length) return;
  if (keepingClips()) {
    if (!corpus.parkCompleted(buf)) {
      diagLog('audio-save-failed', { bytes: buf.length });
      return; // Keep the live recovery copy if the completed save failed.
    }
  } else {
    corpus.clearRetry();
    corpus.dropParked();
  }
  // The whole recording is on disk now, so the partial copy written while it
  // was being spoken has nothing left to insure.
  endLiveClip();
}

// The live copy exists only to survive a session that never ends. Any ending
// at all -- a transcript, a failure, a cancel, or the start of the next
// dictation -- makes it redundant.
function endLiveClip() {
  corpus.dropLive();
}

// Whether a dictation's clip is kept once it has an entry: for playback and
// retry, or as a would-be training pair. Both are off means it is deleted the
// moment the transcript is back, as it always was.
function keepingClips() {
  return settings.keepRecordings !== false || !!settings.keepTrainingAudio;
}

// The retention rule for kept recordings. Playback on: a fortnight and half a
// gigabyte. Playback off with training on: the small window a correction has
// to happen in. Either way, an entry gone from history takes its clip along.
function recordingPolicy() {
  const playback = settings.keepRecordings !== false;
  return {
    keepIds: history.entries.map((e) => e.id),
    maxDays: playback ? corpus.RECORDINGS_MAX_DAYS : null,
    maxBytes: playback ? corpus.RECORDINGS_MAX_BYTES : corpus.TRAINING_WINDOW_BYTES,
    maxClips: playback ? null : corpus.TRAINING_WINDOW_CLIPS,
  };
}

// A shelved clip has no entry to be kept alongside, so age and budget are the
// whole rule.
function recoveryPolicy() {
  return {
    maxDays: corpus.RECOVERY_MAX_DAYS,
    maxBytes: corpus.RECOVERY_MAX_BYTES,
    maxClips: corpus.RECOVERY_MAX_CLIPS,
  };
}

// Which engine this dictation was asking for, as the recovery shelf records it.
function currentEngineLabel() {
  return String(settings.asrEngine || '');
}

// A dictation that failed still has the user's words in it. Move the clip off
// the retry slot -- which the next dictation overwrites -- and onto the shelf,
// where the Dictation page can offer it back.
//
// Not every failure has a clip to keep: a microphone that never opened
// recorded nothing, and a paste failure already gave its audio to the history
// entry it created, which is what retryEntryOwner marks.
function keepFailedClip(reason) {
  if (!keepingClips() || retryEntryOwner || !corpus.hasRetry()) return null;
  const id = corpus.keepFailure({
    reason: String(reason || ''),
    source: 'failure',
    engine: currentEngineLabel(),
    exe: lastTarget.exe || '',
    title: lastTarget.title || '',
  });
  if (id) corpus.pruneRecoveries(recoveryPolicy());
  return id;
}

// A clip still in the retry slot at launch belongs to a session that never
// ended: a crash, or the machine going down mid-dictation. Those words are the
// user's to recover, not ours to delete on the way past. Unless they reached
// history: the slot also keeps a finished dictation's clip for Retry until
// the next dictation or a clean quit, so a shutdown or a killed process after
// a successful dictation leaves one behind with nothing left to recover.
function rescueUnfinishedClip() {
  if (!keepingClips()) {
    corpus.dropLive();
    return null;
  }
  let id = null;
  const retryAt = corpus.retryWrittenAt();
  if (retryAt && history.entries.some((entry) => entry.ts > retryAt)) {
    corpus.dropLive();
  } else if (corpus.hasRetry()) {
    id = corpus.keepFailure({
      reason: 'Vell closed before this dictation finished',
      source: 'crash',
      engine: currentEngineLabel(),
    });
    // The recording finished, so the copy written while it was being spoken is
    // the same words with the ending missing. Only one of them is worth
    // offering back.
    corpus.dropLive();
  } else if (corpus.hasLive()) {
    // Nothing finished: the session ended mid-sentence. This partial copy is
    // all there is, which is exactly the case it was written for.
    id = corpus.rescueLive({
      reason: 'Vell closed while you were dictating',
      engine: currentEngineLabel(),
    });
  }
  if (id) corpus.pruneRecoveries(recoveryPolicy());
  return id;
}

function pruneRecordings() {
  if (!keepingClips()) {
    const retryCleared = corpus.clearRetry();
    const recordingsCleared = corpus.clearRecordings();
    // clearRecoveries() takes the live copy with it, but a dictation running
    // while the setting is switched off would write a new one; the renderer is
    // told to stop on the same broadcast.
    const recoveriesCleared = corpus.clearRecoveries();
    recordingsError = retryCleared && recordingsCleared && recoveriesCleared ? '' : 'Some recordings could not be deleted. Close other apps using them and try again.';
    return;
  }
  // Automatic orphan cleanup waits for preserved statistics in both copies.
  // Explicitly turning recordings off above must always honor that choice.
  if (history.cleanupPending) return;
  corpus.prune(recordingPolicy());
  corpus.pruneRecoveries(recoveryPolicy());
}

// History entries as the window sees them: each flagged with whether its
// recording is still on disk, so a card knows whether it can play, save or
// retry before it asks.
function entriesWithAudio() {
  const ids = corpus.recordingIds();
  return history.entries.map((e) => (ids.has(e.id) ? Object.assign({}, e, { audio: true }) : e));
}

// The recovery shelf as the window sees it: no file paths, and nothing at all
// when the setting that keeps these clips is off.
function recoveryList() {
  if (!keepingClips()) return [];
  return corpus.recoveries().map((r) => ({
    id: r.id,
    ts: r.ts,
    seconds: r.seconds,
    bytes: r.size,
    reason: r.reason,
    source: r.source,
    exe: r.exe,
    title: r.title,
  }));
}

// What the recogniser is asked for, which is not always what the dictation is.
// There is no GPU plan: Voz runs on the CPU through onnxruntime-node on every
// platform, so there are no packs and no processor choice.
function currentGpuPlan() {
  return { packsOffered: false, device: 'cpu' };
}

// The engine this platform actually offers.
//
// Vell ships one engine, so every setting, override and stale file resolves
// to Voz here. The file is left alone.
function effectiveEngine() {
  return 'voz';
}

// The processor setting is always the CPU: Voz runs on onnxruntime-node,
// which has no GPU path in the app process.
function effectiveDevice() {
  return 'cpu';
}

// GPU acceleration went away with the CUDA/Qwen packs: Voz runs on the CPU
// through onnxruntime-node on every platform.

// One engine hears every clip, so there is nothing to route between. The
// planner still records which engine ran and how the dictionary was honoured,
// which is what the history entry and diagnostics read.
function planDictationRoute(options) {
  const opts = options || {};
  const language = opts.language || textLanguage();
  const ranked = opts.ranked || vocabularyForDictation(language);
  const plan = capabilities.planRoute({
    engine: 'voz',
    language,
    termCount: ranked.length || Math.max(0, Number(opts.termCount) || 0),
  });
  return {
    language,
    ranked,
    plan,
    engine: 'voz',
    vocabularyVia: plan.vocabularyVia,
    fallbackFrom: null,
  };
}

// Which engine will run this clip. History prefers the reported engine.
function asrEngineFor() {
  return 'voz';
}

let vozProviderInstance = null;
function sharedVozProvider() {
  if (!vozProviderInstance) vozProviderInstance = createProvider('voz');
  return vozProviderInstance;
}

// Transcribe a saved WAV through the Voz provider and record what the
// pipeline downstream needs: the engine that ran, and word-level segments
// for repair and retry. Throws when the model is not installed so the banner
// can explain it instead of failing silently.
async function vozTranscribe(wavPath, options) {
  const opts = options || {};
  if (!vozModelManager || !vozModelManager.installed()) {
    throw new Error('The Voz model is not installed. Download it in Settings, Speech engines.');
  }
  // Name a cold start up front: the weights are not resident, so this
  // transcription pays a reload before inference begins. The bar says so
  // instead of looking stuck on "Transcribing…".
  const cold = !vozLoaded;
  if (cold && mode === 'transcribing') {
    sendOverlay({ mode: 'transcribing', text: 'Loading model…', reveal: true });
  }
  const language = opts.language || textLanguage();
  const work = sharedVozProvider().transcribe({ wavPath, language });
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 120000;
  let timer = null;
  try {
    const result = await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Voz timed out transcribing the recording.')), timeoutMs);
      }),
    ]);
    lastAsrReport = {
      engine: 'voz',
      device: 'cpu',
      vocabulary: '',
      routed: 'voz',
      segments: (result && result.segments) || null,
      // Engine-reported inference time, so the stats can split it from file
      // IO and any cold model (re)load inside the measured window.
      modelRecognitionMs: Number(result && result.processingTime) > 0
        ? Math.round(Number(result.processingTime))
        : 0,
      rtf: Number(result && result.realtimeFactor) > 0
        ? Number(result.realtimeFactor)
        : 0,
      coldStart: !!(result && result.coldStart),
      loadMs: Number(result && result.loadMs) > 0
        ? Math.round(Number(result.loadMs))
        : 0,
    };
    if (lastAsrReport.coldStart) {
      diagLog('transcribe-cold-start', { loadMs: lastAsrReport.loadMs });
    }
    lastVocabularyReport = {
      selectedEngine: 'voz',
      selectedDevice: 'cpu',
      backend: 'cpu',
      gpuName: '',
      computeType: '',
      packId: '',
      fallbackReason: '',
      engine: 'voz',
      device: 'cpu',
      language,
      mechanism: 'repair',
      via: 'repair',
      offered: 0,
      sent: 0,
      tokens: 0,
      dropped: 0,
      droppedTerms: [],
      reason: '',
      fallbackFrom: '',
      degraded: false,
      lostCapabilities: [],
      summary: 'Voz',
    };
    markModelUsed();
    return (result && result.text) || '';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Resolve when the Voz model is ready to transcribe, warming the provider in
// the background on the way. Rejects when there is no model to load so the
// banner can explain instead of failing silently.
async function ensureVozReady() {
  if (!vozModelManager || !vozModelManager.installed()) {
    throw new Error('The Voz model is not installed. Download it in Settings, Speech engines.');
  }
  await ensureVoz();
  markModelUsed();
}

function dictationHotkeyHandler() {
  // globalShortcut reports key-down but has no matching key-up callback. The
  // native watcher owns both edges in PTT mode; accepting this callback too
  // would start or stop the same recording twice.
  if (isPtt()) return;
  if (chordStaleHeld) return;
  if (mode === 'idle' || mode === 'success' || mode === 'error' || mode === 'learned' || mode === 'cancel') startRecording(true);
  else if (mode === 'arming' || mode === 'recording') requestStop();
}

function lastDictationText() {
  const entry = history.entries && history.entries[0];
  return entry ? String(entry.text || '').trim() : '';
}

function flashHud(kind, text, ms) {
  const next = kind === 'error' ? 'error' : 'success';
  showOverlay();
  makeUnfocusable(overlayWin);
  mode = next;
  sendOverlay({ mode: next, text: text || '', reveal: true });
  if (successTimer) clearTimeout(successTimer);
  successTimer = setTimeout(() => {
    mode = 'idle';
    sendOverlay({ mode: 'idle' });
  }, Number(ms) || 1600);
}

async function pasteLastDictation() {
  if (pasteLastBusy) return;
  if (mode === 'arming' || mode === 'recording' || mode === 'transcribing') return;
  const text = lastDictationText();
  if (!text) {
    flashHud('error', 'Nothing to paste', 1600);
    return;
  }
  pasteLastBusy = true;
  stopCorrectionLearning();
  try {
    await rememberFocus();
    makeUnfocusable(overlayWin);
    await pasteText(text, { pasteLast: true });
    flashHud('success', text, 1200);
  } catch (err) {
    const admin = !!(err && err.adminTarget);
    if (admin) noteAdminApp(lastTarget.exe);
    diagLog('paste-last-failed', { exe: lastTarget.exe || '', reason: String(err && err.message || err).slice(0, 80) });
    flashHud('error', admin ? ADMIN_PASTE_FLASH
      : err && err.fullscreenInFront ? FULLSCREEN_PASTE_FLASH
      : 'Paste failed — click your text field and try again', 2400);
  } finally {
    pasteLastBusy = false;
  }
}

function sameShortcut(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function unregisterDictationShortcut() {
  if (registeredShortcut) {
    try { globalShortcut.unregister(registeredShortcut); } catch (_) {}
    registeredShortcut = null;
  }
}

function unregisterPasteLastShortcut() {
  if (registeredPasteShortcut) {
    try { globalShortcut.unregister(registeredPasteShortcut); } catch (_) {}
    registeredPasteShortcut = null;
  }
}

const shortcutFailureReason = hotkeys.shortcutFailureReason;

function stopChordWatch() {
  if (chordWatchRestartTimer) {
    clearTimeout(chordWatchRestartTimer);
    chordWatchRestartTimer = null;
  }
  chordWatchAccel = '';
  chordWatchRestartDelay = 250;
  chordStaleHeld = false;
  if (chordWatch) {
    const proc = chordWatch;
    chordWatch = null;
    try { proc.kill(); } catch (_) {}
  }
}

function scheduleChordWatchRestart(accel) {
  if (isQuitting || chordWatchRestartTimer || !sameShortcut(chordWatchAccel, accel)) return;
  const delay = chordWatchRestartDelay;
  chordWatchRestartDelay = Math.min(5000, chordWatchRestartDelay * 2);
  chordWatchRestartTimer = setTimeout(() => {
    chordWatchRestartTimer = null;
    if (!isQuitting && !chordWatch && sameShortcut(chordWatchAccel, accel)
        && !launchChordWatch(accel)) scheduleChordWatchRestart(accel);
  }, delay);
}

// One compiled Win32 loop reports physical DOWN/UP edges for every PTT chord.
// It replaces the old 70 ms setInterval that started a new PowerShell process
// on every tick and treated a timeout or empty result as a key release.
// The Windows and macOS helpers both watch key edges. A platform without a
// watcher has no release edge, so isPtt() reports toggle mode there and the
// plain globalShortcut carries the dictation hotkey on its own.
function chordWatchSupported() {
  return process.platform === 'win32' || process.platform === 'darwin';
}

// "DOWN modified": the key came down with Shift, Ctrl, Alt or Windows already
// held (win32.ps1 WatchChord). For a lone key that is the app's own shortcut
// -- Shift+F8 in an editor -- so the press and its release are left alone,
// except over a fullscreen game, where a held sprint or crouch key is normal.
function modifiedPressIgnored(msg, accel) {
  return msg === 'DOWN modified' && hotkeys.isLoneKey(accel) && !foregroundFillsMonitor;
}

function launchChordWatch(accel) {
  if (!chordWatchSupported()) return false;
  const encoded = hotkeys.encodeChordFor(process.platform, accel);
  if (!encoded) return false;
  let proc;
  const cmd = helperCommand(['-Action', 'hotkey-watch', '-Vks', encoded]);
  try {
    proc = spawn(cmd.file, cmd.args, { windowsHide: true });
  } catch (_) {
    return false;
  }
  chordWatch = proc;
  const bornAt = Date.now();
  let buf = '';
  let errTail = '';
  let skipPress = false;
  proc.stdout.on('data', (chunk) => {
    if (chordWatch !== proc) return;
    chordWatchRestartDelay = 250;
    buf += String(chunk);
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() || '';
    for (const line of lines) {
      const { msg, heldMs } = watcherLine(line.trim());
      if (!msg) continue;
      // The watcher's opening line says whether the chord was already down
      // when it started looking. That hold predates the watcher, so it is
      // never a press: "UP stale" only ends a recording a previous watcher
      // began before it died mid-hold, and FREE one whose release fell
      // between the two watchers.
      if (msg === 'HELD') { chordStaleHeld = true; continue; }
      if (msg === 'FREE') {
        chordStaleHeld = false;
        endPttMissedRelease('dictation');
        continue;
      }
      if (msg === 'UP stale') {
        chordStaleHeld = false;
        if (isPtt() && pttOwner === 'dictation' && (mode === 'arming' || mode === 'recording')) requestPttStop();
        continue;
      }
      if (msg === 'DOWN' || msg === 'DOWN modified') skipPress = modifiedPressIgnored(msg, chordWatchAccel);
      if (skipPress) {
        if (msg.startsWith('UP')) skipPress = false;
        continue;
      }
      // Push to talk wants the edges; toggle wants one event per press, and it
      // has to be the release -- "dirty" is how a chord that was really
      // Ctrl+Win+Left stays a virtual-desktop switch and nothing more. For a
      // lone key that came down on its own (above), dirty is only W held to
      // move or a click in a game, and the press counts.
      const lone = hotkeys.isLoneKey(chordWatchAccel);
      if (isPtt()) {
        if (msg === 'DOWN' || msg === 'DOWN modified') pttPress();
        // Push to talk cannot know a chord is dirty until it ends, so it starts
        // recording either way and throws the result out rather than leaving a
        // stray transcript behind every virtual-desktop switch.
        else if (msg === 'UP dirty') pttRelease(!lone, { heldMs });
        else if (msg === 'UP clean') pttRelease(false, { heldMs });
      } else if ((msg === 'UP clean' && (lone || hotkeys.isModifierOnly(chordWatchAccel)))
          || (msg === 'UP dirty' && lone)) {
        dictationHotkeyHandler();
      }
    }
  });
  // The last of what the watcher printed to stderr: a PowerShell that cannot
  // compile its helper says why there and nowhere else.
  if (proc.stderr) proc.stderr.on('data', (chunk) => { errTail = (errTail + String(chunk)).slice(-200); });
  const lost = (why) => {
    if (chordWatch === proc) {
      chordWatch = null;
      diagLog('key-watch-lost', {
        key: 'dictation', why, aliveMs: Date.now() - bornAt,
        recording: pttRecordingOf('dictation'), stderr: errTail.trim().slice(-120),
      });
      scheduleChordWatchRestart(accel);
    }
  };
  proc.on('error', (err) => lost('error ' + String((err && (err.code || err.message)) || '').slice(0, 40)));
  proc.on('exit', (code, signal) => lost(signal ? 'signal ' + signal : 'exit ' + code));
  return true;
}

function startChordWatch(accel) {
  stopChordWatch();
  chordWatchAccel = accel;
  chordWatchRestartDelay = 250;
  if (launchChordWatch(accel)) return true;
  chordWatchAccel = '';
  return false;
}

function tryRegisterDictationShortcut(accel) {
  unregisterDictationShortcut();
  stopChordWatch();
  const candidate = accel || settings.shortcut || hotkeys.defaultShortcut();
  if (sameShortcut(candidate, settings.pasteLastShortcut)) {
    return { ok: false, reason: formatShortcutLabel(candidate) + ' is already used to paste your last dictation.' };
  }
  if (hotkeys.isModifierOnly(candidate)) {
    if (!startChordWatch(candidate)) {
      return { ok: false, reason: formatShortcutLabel(candidate) + ' could not be watched. Try another combination.' };
    }
    registeredShortcut = null;
    return { ok: true, reason: '' };
  }
  // A lone key toggles from the watcher's release, like a modifier-only chord:
  // RegisterHotKey wants the modifiers exact, so with Shift held to sprint, F8
  // would never reach it. It is still registered, so that a plain press is
  // kept from the app in front -- F5 does not also reload the page.
  const lone = hotkeys.isLoneKey(candidate) && chordWatchSupported();
  try {
    const ok = globalShortcut.register(candidate, lone ? () => {} : dictationHotkeyHandler);
    if (!ok) return { ok: false, reason: shortcutFailureReason(candidate, false) };
    registeredShortcut = candidate;
    if (chordWatchSupported() && !startChordWatch(candidate)) {
      unregisterDictationShortcut();
      return { ok: false, reason: formatShortcutLabel(candidate) + ' could not be watched. Try another combination.' };
    }
    return { ok: true, reason: '' };
  } catch (_) {
    return { ok: false, reason: shortcutFailureReason(candidate, true) };
  }
}

function tryRegisterPasteLastShortcut(accel) {
  unregisterPasteLastShortcut();
  const candidate = accel || settings.pasteLastShortcut || 'CommandOrControl+Alt+V';
  if (sameShortcut(candidate, settings.shortcut)) {
    return { ok: false, reason: formatShortcutLabel(candidate) + ' is already used for dictation.' };
  }
  try {
    const ok = globalShortcut.register(candidate, () => {
      pasteLastDictation().catch(() => {});
    });
    if (!ok) return { ok: false, reason: shortcutFailureReason(candidate, false) };
    registeredPasteShortcut = candidate;
    return { ok: true, reason: '' };
  } catch (_) {
    return { ok: false, reason: shortcutFailureReason(candidate, true) };
  }
}

// --- the game shortcut ------------------------------------------------------
// Works the same as the dictation shortcut -- toggle, or push to talk -- from
// its own native key watcher, because Windows' hotkey fires again for every
// auto-repeat of a held key: a gamer holding F8 like a push-to-talk key would
// start a dictation and stop it half a second later. Any key held with it is
// play, never a different chord, so the watcher's "dirty" means nothing here.
// Windows' hotkey is still registered, with nothing to do, so that a press is
// kept from the game in front.
let registeredGameShortcut = null;
let gameWatch = null;
let gameWatchAccel = '';
let gameWatchRestartTimer = null;
let gameWatchRestartDelay = 250;
// A key already down when its watcher starts -- the user's finger still on the
// key they just picked -- is not a press.
let gameStaleHeld = false;

function gameToggle() {
  if (gameStaleHeld) return;
  if (mode === 'idle' || mode === 'success' || mode === 'error' || mode === 'learned' || mode === 'cancel') {
    startRecording(true, { game: true });
  } else if (mode === 'arming' || mode === 'recording') {
    requestStop();
  }
}

function stopGameWatch() {
  if (gameWatchRestartTimer) {
    clearTimeout(gameWatchRestartTimer);
    gameWatchRestartTimer = null;
  }
  gameWatchAccel = '';
  gameWatchRestartDelay = 250;
  gameStaleHeld = false;
  if (gameWatch) {
    const proc = gameWatch;
    gameWatch = null;
    try { proc.kill(); } catch (_) {}
  }
}

function launchGameWatch(accel) {
  if (!chordWatchSupported()) return false;
  const encoded = hotkeys.encodeChordFor(process.platform, accel);
  if (!encoded) return false;
  let proc;
  const cmd = helperCommand(['-Action', 'hotkey-watch', '-Vks', encoded]);
  try {
    proc = spawn(cmd.file, cmd.args, { windowsHide: true });
  } catch (_) {
    return false;
  }
  gameWatch = proc;
  const bornAt = Date.now();
  let buf = '';
  let errTail = '';
  let skipPress = false;
  proc.stdout.on('data', (chunk) => {
    if (gameWatch !== proc) return;
    gameWatchRestartDelay = 250;
    buf += String(chunk);
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() || '';
    for (const line of lines) {
      const { msg, heldMs } = watcherLine(line.trim());
      if (msg === 'DOWN' || msg === 'DOWN modified') skipPress = modifiedPressIgnored(msg, accel);
      if (skipPress) {
        if (msg.startsWith('UP')) skipPress = false;
        continue;
      }
      if (msg === 'HELD') gameStaleHeld = true;
      else if (msg === 'FREE') {
        gameStaleHeld = false;
        endPttMissedRelease('game');
      } else if (msg === 'UP stale') {
        gameStaleHeld = false;
        if (isPtt() && pttOwner === 'game' && (mode === 'arming' || mode === 'recording')) requestPttStop();
      } else if (isPtt()) {
        if (msg === 'DOWN' || msg === 'DOWN modified') pttPress({ game: true });
        else if (msg === 'UP clean' || msg === 'UP dirty') pttRelease(false, { game: true, heldMs });
      } else if (msg === 'UP clean' || msg === 'UP dirty') {
        gameToggle();
      }
    }
  });
  if (proc.stderr) proc.stderr.on('data', (chunk) => { errTail = (errTail + String(chunk)).slice(-200); });
  const lost = (why) => {
    if (gameWatch !== proc) return;
    gameWatch = null;
    diagLog('key-watch-lost', {
      key: 'game', why, aliveMs: Date.now() - bornAt,
      recording: pttRecordingOf('game'), stderr: errTail.trim().slice(-120),
    });
    if (isQuitting || gameWatchRestartTimer || !sameShortcut(gameWatchAccel, accel)) return;
    const delay = gameWatchRestartDelay;
    gameWatchRestartDelay = Math.min(5000, gameWatchRestartDelay * 2);
    gameWatchRestartTimer = setTimeout(() => {
      gameWatchRestartTimer = null;
      if (!isQuitting && !gameWatch && sameShortcut(gameWatchAccel, accel)) launchGameWatch(accel);
    }, delay);
  };
  proc.on('error', (err) => lost('error ' + String((err && (err.code || err.message)) || '').slice(0, 40)));
  proc.on('exit', (code, signal) => lost(signal ? 'signal ' + signal : 'exit ' + code));
  return true;
}

function unregisterGameShortcut() {
  if (registeredGameShortcut) {
    try { globalShortcut.unregister(registeredGameShortcut); } catch (_) {}
    registeredGameShortcut = null;
  }
  stopGameWatch();
}

// Windows only: what makes it the game's way -- the sound left on, no fake
// key-ups, no game pulled forward -- is all win32.ps1.
function tryRegisterGameShortcut(accel) {
  unregisterGameShortcut();
  // Off is nothing taken and nothing watched: the key belongs to every other
  // app until the user turns game typing on.
  if (process.platform !== 'win32' || settings.gameShortcutEnabled !== true) return { ok: true, reason: '' };
  const candidate = accel || settings.gameShortcut || GAME_SHORTCUT_DEFAULT;
  if (sameShortcut(candidate, settings.shortcut)) {
    return { ok: false, reason: formatShortcutLabel(candidate) + ' is already used for dictation.' };
  }
  if (sameShortcut(candidate, settings.pasteLastShortcut)) {
    return { ok: false, reason: formatShortcutLabel(candidate) + ' is already used to paste your last dictation.' };
  }
  if (!hotkeys.isModifierOnly(candidate)) {
    try {
      if (!globalShortcut.register(candidate, () => {})) {
        return { ok: false, reason: shortcutFailureReason(candidate, false) };
      }
      registeredGameShortcut = candidate;
    } catch (_) {
      return { ok: false, reason: shortcutFailureReason(candidate, true) };
    }
  }
  gameWatchAccel = candidate;
  if (!launchGameWatch(candidate)) {
    unregisterGameShortcut();
    return { ok: false, reason: formatShortcutLabel(candidate) + ' could not be watched. Try another key.' };
  }
  return { ok: true, reason: '' };
}

function registerHotkeys() {
  // A hotkey that will not register at launch gets swapped for the default.
  // That used to happen in total silence: the shortcut shown in settings was
  // simply not the one the user picked, with nothing to say why. The notice
  // stands until the shortcut is changed or the app is restarted.
  //
  // settings.shortcut is reassigned but deliberately not saved -- next launch
  // should try the user's real choice again, in case whatever was holding the
  // chord is gone.
  const notices = [];

  const dictation = tryRegisterDictationShortcut(settings.shortcut);
  if (!dictation.ok) {
    settings.shortcut = hotkeys.defaultShortcut();
    const fallback = tryRegisterDictationShortcut(settings.shortcut);
    notices.push(dictation.reason + (fallback.ok
      ? ' Dictation is on ' + formatShortcutLabel(settings.shortcut) + ' for now.'
      : ' Dictation has no shortcut right now.'));
  }

  const paste = tryRegisterPasteLastShortcut(settings.pasteLastShortcut);
  if (!paste.ok) {
    settings.pasteLastShortcut = sameShortcut(settings.shortcut, 'CommandOrControl+Alt+V')
      // "Period" is not an accelerator name Electron accepts -- it throws on
      // conversion, which this function's catch turned into "no paste hotkey at
      // all". The literal character is the spelling that registers.
      ? 'CommandOrControl+Shift+.'
      : 'CommandOrControl+Alt+V';
    const fallback = tryRegisterPasteLastShortcut(settings.pasteLastShortcut);
    notices.push(paste.reason + (fallback.ok
      ? ' Paste last is on ' + formatShortcutLabel(settings.pasteLastShortcut) + ' for now.'
      : ' Paste last has no shortcut right now.'));
  }

  // No fallback key for games: a key Vell takes stops working everywhere
  // else, so it does not take one the user did not choose.
  const game = tryRegisterGameShortcut(settings.gameShortcut);
  if (!game.ok) notices.push(game.reason + ' The game shortcut is off until you pick another key.');

  hotkeyNotice = notices.join(' ');
}

ipcMain.on('hud-ready', (e) => {
  if (!overlayWin || overlayWin.isDestroyed() || e.sender !== overlayWin.webContents) return;
  overlayReady = true;
  resetOverlayHealth();
  // The first hotkey can beat the page's listener on a cold PC. Replay the
  // current state so its microphone can start; an unconditional idle here
  // left main recording while the page showed an unresponsive resting bar.
  const reveal = restingBarWanted() || mode !== 'idle';
  if (reveal) showOverlay();
  const playOpeningCue = openingCuePending && mode === 'idle' && settings.soundsEnabled !== false
    && !process.argv.includes('--hidden') && !macShell.openedAtLogin(app, process.platform);
  openingCuePending = false;
  sendOverlay({ reveal, playOpeningCue });
});
ipcMain.on('hud-pong', (e, seq) => {
  if (!overlayWin || overlayWin.isDestroyed() || e.sender !== overlayWin.webContents) return;
  overlayHealth.answer(Number(seq), Date.now());
  overlayFrameHealth.pong(Number(seq));
});
ipcMain.on('hud-frame', (e, seq) => {
  if (!overlayWin || overlayWin.isDestroyed() || e.sender !== overlayWin.webContents) return;
  overlayFrameHealth.answer(Number(seq));
});
// The page's own diagnostics, kept to numbers and short strings: the log is
// for what the app measured, never for what the user said.
ipcMain.on('hud-diag', (e, event, fields) => {
  if (!overlayWin || overlayWin.isDestroyed() || e.sender !== overlayWin.webContents) return;
  const clean = {};
  if (fields && typeof fields === 'object') {
    for (const key of Object.keys(fields).slice(0, 16)) {
      const v = fields[key];
      if (typeof v === 'number' || typeof v === 'boolean') clean[key] = v;
      else if (typeof v === 'string') clean[key] = v.slice(0, 40);
    }
  }
  diagLog('hud-' + String(event || '').slice(0, 40), clean);
});
// `timing` is the page's own account of how long its microphone took, in
// milliseconds: { micMs, holdMs }. Optional and only ever diagnostic.
ipcMain.on('capture-ready', (e, timing) => {
  if (!overlayWin || overlayWin.isDestroyed() || e.sender !== overlayWin.webContents) return;
  if (mode !== 'arming' || mediaPreparing) return;
  if (armTiming && !armTiming.readyAt) {
    armTiming.readyAt = Date.now();
    const t = timing && typeof timing === 'object' ? timing : {};
    if (Number.isFinite(t.micMs) && t.micMs >= 0) armTiming.micMs = t.micMs;
    if (Number.isFinite(t.holdMs) && t.holdMs >= 0) armTiming.holdMs = t.holdMs;
  }
  clearArmingTimer();
  const stopOnReady = pttReleasePending;
  pttReleasePending = false;
  recordingStartedAt = Date.now();
  mode = 'recording';
  sendOverlay({ mode: 'recording' });
  if (stopOnReady) requestStop();
});
ipcMain.on('hud-hidden', (e) => {
  // Only the overlay may hide the overlay. The same preload is loaded by the
  // main window, and a stray call from there would take the bar off screen
  // with nothing to bring it back.
  if (!overlayWin || overlayWin.isDestroyed() || e.sender !== overlayWin.webContents) return;
  hideOverlayWindow();
});
ipcMain.on('hud-ignore-mouse', (e, ignore) => {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  if (e.sender !== overlayWin.webContents) return;
  // Hover IPC may have been queued while idle, before a hotkey started the
  // microphone. Active controls must never become click-through because of
  // that older request. Main's cursor sample owns idle hit testing too.
  setOverlayMouseIgnore(mode === 'idle' && !overlayEditing && !overlayDrag
    ? !!ignore && !overlayHover : false);
});
ipcMain.on('overlay-drag-start', (e) => {
  if (!overlayWin || overlayWin.isDestroyed() || e.sender !== overlayWin.webContents) return;
  startOverlayDrag();
});
ipcMain.on('overlay-drag-end', (e) => {
  if (!overlayWin || overlayWin.isDestroyed() || e.sender !== overlayWin.webContents) return;
  stopOverlayDrag(true);
});
ipcMain.on('overlay-settings', (e) => {
  if (!overlayWin || overlayWin.isDestroyed() || e.sender !== overlayWin.webContents) return;
  openHistory('general');
});
ipcMain.on('app-ready', () => {
  if (historyWin && !historyWin.isDestroyed()) {
    historyWin.webContents.send('history-updated', snapshot());
    if (pendingSettingsCat) {
      historyWin.webContents.send('open-settings', pendingSettingsCat);
      pendingSettingsCat = '';
    }
  }
});
ipcMain.on('mic-devices', (e, payload) => {
  if (!historyWin || historyWin.isDestroyed() || e.sender !== historyWin.webContents) return;
  const list = (payload && Array.isArray(payload.devices)) ? payload.devices : [];
  micDevices = list
    .filter((d) => d && d.id)
    .map((d) => ({ id: String(d.id), label: String(d.label || 'Microphone') }));
  micDefaultId = String((payload && payload.defaultId) || '');
  refreshTray();
});
ipcMain.handle('flow-bar-reset', async () => {
  resetFlowBarPosition();
  broadcast();
  return snapshot();
});
ipcMain.handle('toggle', async () => { toggleListen(); return { mode, engine }; });
ipcMain.on('hud-cancel', () => cancelListen());
ipcMain.on('hud-confirm', () => {
  if (mode === 'arming' || mode === 'recording') requestStop();
  else if (mode === 'success' || mode === 'error') retryLast();
});
ipcMain.on('overlay-hold', (e) => {
  if (!overlayWin || overlayWin.isDestroyed() || e.sender !== overlayWin.webContents) return;
  if (mode !== 'success' && mode !== 'error' && mode !== 'learned') return;
  // Editing takes focus, and a game's result is never worth taking it from
  // the game (the bar is click-through then too: setOverlayMouseIgnore).
  if (gameDictation) return;
  if (successTimer) {
    clearTimeout(successTimer);
    successTimer = null;
  }
  if (mode === 'learned') {
    setOverlayMouseIgnore(false);
    return;
  }
  overlayEditing = true;
  try { overlayWin && overlayWin.setFocusable(true); } catch (_) {}
  if (overlayWin && !overlayWin.isDestroyed()) {
    positionOverlay();
    overlayWin.focus();
  }
  setOverlayMouseIgnore(false);
});
ipcMain.on('overlay-release', (e) => {
  if (!overlayWin || overlayWin.isDestroyed() || e.sender !== overlayWin.webContents) return;
  if (mode === 'learned') {
    dismissAutoLearnLater(autoLearnNotice && autoLearnNotice.undoToken ? 8000 : 1800);
    return;
  }
  overlayEditing = false;
  makeUnfocusable(overlayWin);
  positionOverlay();
  if (mode === 'success' || mode === 'error') {
    if (successTimer) clearTimeout(successTimer);
    successTimer = setTimeout(() => {
      mode = 'idle';
      sendOverlay({ mode: 'idle' });
    }, 1400);
  }
});
ipcMain.on('transcript', (e, text) => {
  if (!overlayWin || overlayWin.isDestroyed() || e.sender !== overlayWin.webContents) return;
  if (mode !== 'transcribing' && mode !== 'recording') return;
  const token = recordingSessionToken;
  onTranscript(text, token).catch(err => {
    if (token !== recordingSessionToken) return;
    console.error('Could not save dictation:', err);
    flashError('Could not save dictation');
  });
});
ipcMain.on('capture-failed', (e, msg) => {
  if (!overlayWin || overlayWin.isDestroyed() || e.sender !== overlayWin.webContents) return;
  if (mode !== 'arming' && mode !== 'recording' && mode !== 'transcribing') return;
  flashError(friendlyEngineError(msg || 'Mic error'));
});
// A block of the dictation still being spoken, written straight to disk. This
// is the only copy that exists before the user stops talking, so it is also
// the only thing a power cut cannot take away. The renderer sends these every
// few seconds once a dictation is long enough to be worth insuring.
ipcMain.on('capture-flush', (e, pcm, sampleRate) => {
  if (!overlayWin || overlayWin.isDestroyed() || e.sender !== overlayWin.webContents) return;
  // A block that arrives after the recording ended belongs to a clip that is
  // already whole somewhere else, and would otherwise start a new live file
  // that nothing ever closes.
  if (mode !== 'arming' && mode !== 'recording') return;
  if (!keepingClips()) return;
  corpus.appendLive(Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm), sampleRate);
});
ipcMain.on('start-cue-heard', (e, token) => {
  if (!overlayWin || overlayWin.isDestroyed() || e.sender !== overlayWin.webContents) return;
  if (armTiming && !armTiming.cueAt && token === recordingSessionToken) armTiming.cueAt = Date.now();
  if (startCueHeard && startCueHeard.token === token) startCueHeard.done(true);
});
ipcMain.on('capture-ended', (e) => {
  if (!overlayWin || overlayWin.isDestroyed() || e.sender !== overlayWin.webContents) return;
  // A stale renderer message must not unmute a newer dictation. Normal capture
  // teardown arrives after requestStop has moved this session to transcribing.
  if (mode === 'transcribing') resumeBackgroundMedia();
});
// The user stopped and the recording held speech (the overlay's gate passed).
// From now on every piece of it goes up on the tail lane, and the relay is
// asked to start its fast model on the body pieces still out instead of
// waiting for MAI. Not awaited: the answers arrive on the pieces' own requests.
ipcMain.on('cancelled', (e) => {
  if (!overlayWin || overlayWin.isDestroyed() || e.sender !== overlayWin.webContents) return;
  if (mode !== 'arming' && mode !== 'recording' && mode !== 'transcribing') return;
  mode = 'idle';
  registerEscape(false);
  makeUnfocusable(overlayWin);
  sendOverlay({ mode: 'idle' });
});
async function transcribeSavedFile(file) {
  const seconds = corpus.wavSeconds(file);
  const opts = { timeoutMs: transcriptionTimeout(seconds) };
  return vozTranscribe(file, opts);
}

// Only the app's own pages run in its windows: a file under this folder.
function isAppPage(url) {
  try {
    const u = new URL(String(url || ''));
    if (u.protocol !== 'file:') return false;
    const file = path.normalize(require('url').fileURLToPath(u)).toLowerCase();
    return file.startsWith(path.normalize(__dirname + path.sep).toLowerCase());
  } catch (_) {
    return false;
  }
}

// A link that would open a window (target="_blank", window.open) goes to
// the browser when it is https, and nowhere otherwise. Any navigation away
// from the app's pages -- a plain link, a dropped file or URL, a redirect --
// is refused, so no outside page ever runs beside the preload's bridge or
// asks for the microphone.
function lockToAppPages(win) {
  const wc = win && win.webContents;
  if (!wc) return;
  if (typeof wc.setWindowOpenHandler === 'function') {
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//i.test(String(url || '')) && shell && typeof shell.openExternal === 'function') {
        shell.openExternal(url).catch(() => {});
      }
      return { action: 'deny' };
    });
  }
  if (typeof wc.on === 'function') {
    const stay = (event, url) => { if (!isAppPage(url)) event.preventDefault(); };
    wc.on('will-navigate', stay);
    wc.on('will-redirect', stay);
  }
}

// The Writing style preview, for the sandboxed preload (preload.js).
ipcMain.handle('style-preview', (_e, text, tone, clean) => {
  const sample = String(text || '').slice(0, 500);
  try {
    return style.applyStyleWithTone(clean === true ? autoCleanup(sample) : sample, String(tone || ''));
  } catch (_) {
    return sample;
  }
});

ipcMain.handle('transcribe-local', async (_e, wav, options) => {
  const buf = Buffer.isBuffer(wav) ? wav : Buffer.from(wav);
  const opts = Object.assign({}, options || {});
  const sessionToken = recordingSessionToken;
  if (opts.park !== false) {
    retryEntryOwner = null;
    if (keepingClips()) corpus.parkRetry(buf);
    else corpus.clearRetry();
  }
  // 16 kHz mono 16-bit: the clip length is in the byte count. A long clip on
  // a CPU engine can legitimately outlast a flat minute, and a timeout that
  // fires while the engine is still decoding leaves the next request queued
  // behind work nobody will read.
  const audioSec = Math.max(0, (buf.length - 44) / 32000);
  opts.timeoutMs = transcriptionTimeout(audioSec);
  let tmp = null;
  const local = async () => {
    tmp = path.join(os.tmpdir(), 'vell-' + Date.now() + '-' + process.hrtime.bigint() + '.wav');
    await fs.promises.writeFile(tmp, buf);
    return vozTranscribe(tmp, opts);
  };
  try {
    const text = await local();
    // Hold the clip until the history entry it becomes can claim it. Without
    // this the audio is gone before the user ever gets to correct it.
    if (opts.park !== false && sessionToken === recordingSessionToken) parkCompletedClip(buf);
    return text;
  } finally {
    if (tmp) fs.unlink(tmp, () => {});
  }
});
ipcMain.handle('park-audio', async (_e, wav) => {
  const buf = Buffer.isBuffer(wav) ? wav : Buffer.from(wav);
  parkCompletedClip(buf);
  return true;
});
ipcMain.handle('app-load', async () => snapshot());
ipcMain.handle('local-model-setup', (_event, engine) => {
  if (!Object.prototype.hasOwnProperty.call(asr.ASR_ENGINES, engine)) throw new Error('Choose a supported speech model.');
  if (!modelPlan.engineOffered(engine, process.platform)) throw new Error('Choose a supported speech model.');
  return runAsrOperation('install', async () => {
    asrSetupController = new AbortController();
    settings.asrEngine = engine;
    settings.localModelChosen = true;
    saveSettings();
    try {
      await setupDictation(asrSetupController.signal);
      engineError = '';
    } catch (err) {
      asrRuntimeState = {
        status: asrSetupController.signal.aborted || err?.code === 'CANCELLED' ? 'cancelled' : 'error',
        progress: null, step: asrRuntimeState.step || 'model',
        message: err?.message || 'The model could not be installed. Try again.',
      };
    }
    saveAsrSetupState();
  });
});
ipcMain.handle('history-stats', async () => historyUsage.getStats(history, historyAnalyticsRevision));
ipcMain.handle('history-insights', async (_event, options) =>
  historyUsage.getInsights(history, dictionary.phrases, historyAnalyticsRevision,
    options && typeof options === 'object' ? options : {}));
ipcMain.handle('asr-runtime-install', () => runAsrOperation('install', async () => {
  asrSetupController = new AbortController();
  try {
    await setupDictation(asrSetupController.signal);
    engineError = '';
  } catch (err) {
    asrRuntimeState = {
      status: asrSetupController.signal.aborted || (err && err.code === 'CANCELLED') ? 'cancelled' : 'error',
      progress: null, step: asrRuntimeState.step || 'model',
      message: err && err.message ? err.message : 'Dictation could not be set up.',
    };
  }
  saveAsrSetupState();
}));
// Download the Voz model (or re-download it). Same operation lock and the
// same progress reporting as a first-time setup, because to a user it is the
// same thing happening.
//
// `options.select` switches to the engine the download belongs to once it is
// on disk. With a single engine that is always Voz, so the switch is a no-op
// kept for the call shape.
ipcMain.handle('speech-model-install', (_e, id, options) => {
  const wanted = String(id || '').trim();
  if (!modelPlan.COMPONENT_IDS.includes(wanted)) return snapshot();
  const select = !!(options && typeof options === 'object' && options.select);
  return runAsrOperation('install', async () => {
    asrSetupController = new AbortController();
    try {
      await setupDictation(asrSetupController.signal, { components: [wanted] });
      engineError = '';
      const nextEngine = select ? engineForComponent(wanted) : '';
      if (nextEngine && nextEngine !== settings.asrEngine) {
        settings.asrEngine = nextEngine;
        saveSettings();
      }
    } catch (err) {
      asrRuntimeState = {
        status: asrSetupController.signal.aborted || (err && err.code === 'CANCELLED') ? 'cancelled' : 'error',
        progress: null,
        step: asrRuntimeState.step || 'model',
        message: err && err.message ? err.message : 'That speech model could not be downloaded.',
      };
    }
    saveAsrSetupState();
  });
});

// Remove the Voz model. Dictation needs it back before it can run again;
// the banner says so. Same operation lock as an install, so a removal cannot
// run under a download or under another removal.
ipcMain.handle('speech-model-remove', (_e, id) => {
  const wanted = String(id || '').trim();
  if (wanted !== 'voz' || !vozModelManager) return snapshot();
  if (asrOperation) return asrOperation.promise;
  return runAsrOperation('remove', async () => {
    asrRuntimeState = { status: 'removing', progress: null, step: 'model',
      message: 'Removing Voz…' };
    broadcast();
    try {
      await cancelListen();
      await vozModelManager.remove();
      setSidecarState('unavailable');
      asrRuntimeState = { status: 'removed', progress: null, step: 'done',
        message: 'Voz was removed. Download it again in Settings to dictate.' };
    } catch (err) {
      asrRuntimeState = { ...removeFailure('Voz', err), step: 'model' };
    }
    saveAsrSetupState();
  });
});

// GPU packs went away with the CUDA/Qwen runtimes: Voz runs on the CPU
// through onnxruntime-node on every platform, so there is nothing to
// install, cancel or remove here.
function removeFailure(label, err) {
  return { status: 'error', progress: null,
    message: 'Could not remove ' + label + ': ' + (err && err.message ? err.message : 'Unknown error') + '. Try again.' };
}

ipcMain.handle('asr-runtime-cancel', () => {
  if (asrSetupController) asrSetupController.abort();
  if (asrOperation && asrOperation.kind === 'install') {
    asrRuntimeState = { ...asrRuntimeState, status: 'cancelling', message: 'Cancelling setup…' };
    broadcast();
  }
  return snapshot();
});
ipcMain.handle('asr-runtime-remove', () => runAsrOperation('remove', async () => {
  asrRuntimeState = { status: 'removing', progress: null, step: 'model', message: 'Removing the Voz model…' };
  broadcast();
  try {
    // Persist the user's intent before touching files. A failed delete or an
    // app restart must never start a model the user just asked to disable.
    fs.mkdirSync(ASR_RUNTIME, { recursive: true });
    fs.writeFileSync(asrDisabledPath(), '{}');
    await cancelListen();
    if (vozModelManager) await vozModelManager.remove();
    asrRuntimeState = { status: 'removed', progress: null,
      message: 'Voz removed. Dictation is disabled until you set it up again.', step: 'done' };
  } catch (err) {
    asrRuntimeState = { status: 'error', progress: null, step: 'model',
      message: 'Could not remove the speech model: ' + (err.message || 'Unknown error')
        + '. Dictation remains disabled. Try Remove again.' };
  }
  engineError = 'Speech is disabled. Set up dictation to use it again.';
  setSidecarState('unavailable');
  saveAsrSetupState();
}));
// Settings > System > Restart as administrator, for the games and apps that
// run as administrator and are out of an ordinary Vell's reach
// (noteAdminApp). Windows elevates only a new process, after its own prompt,
// so this starts a second Vell that way and quits once Windows has started
// it; the new one waits for this one to be gone before it takes the
// single-instance lock (afterPid, at the bottom of this file). A no at the
// prompt leaves this Vell running and the row says so.
//
// The elevated copy starts in System32 whatever folder it is given, so every
// path in its command is absolute (elevation.restartCommand).
//
// One thing is left as it is. The elevated copy does not inherit this
// process's environment variables: Windows starts it with the elevated
// account's own, so a development run loses the VOXDEN_* variables it was
// started with. And a standard Windows user elevates as a different,
// administrator account -- or, with Windows' Administrator protection on, a
// hidden one -- whose AppData, and so whose Vell settings and history, are
// not theirs.
const RESTART_AS_ADMIN_TIMEOUT_MS = 5 * 60 * 1000;
let restartingAsAdmin = false;
ipcMain.handle('restart-as-admin', async () => {
  if (process.platform !== 'win32') return { ok: false, reason: 'Only Windows runs apps as administrator.' };
  if (runningAsAdmin === true) return { ok: false, reason: 'Vell is already running as administrator.' };
  if (restartingAsAdmin || isQuitting) return { ok: false, reason: 'Vell is already restarting.' };
  restartingAsAdmin = true;
  const cmd = elevation.restartCommand({
    packaged: app.isPackaged, execPath: process.execPath,
    appPath: app.getAppPath(), pid: process.pid,
  });
  // The prompt waits on the user, so the timeout is generous. It only frees
  // the button if PowerShell itself hangs.
  const result = await new Promise((resolve) => {
    execFile(elevation.powershellPath(),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', elevation.encodeCommand(elevation.elevatedStartScript(cmd))],
      { windowsHide: true, timeout: RESTART_AS_ADMIN_TIMEOUT_MS },
      (_err, stdout) => resolve(elevation.startResult(stdout)));
  });
  if (!result.ok) {
    restartingAsAdmin = false;
    if (result.detail) console.warn('Restart as administrator failed:', result.detail);
    return { ok: false, reason: result.reason };
  }
  // Once the reply is on its way, so the page is not left waiting on a
  // process that is closing.
  setTimeout(() => app.quit(), 0);
  return { ok: true };
});
// Opening the panel is what counts as reading it, so the badge clears on open
// rather than on a per-item click the user has no reason to make.
ipcMain.handle('notifications-read', async () => {
  applyNotifications(announcements.markAllRead(notifications), { broadcast: false });
  return snapshot();
});
ipcMain.handle('notifications-dismiss', async (_e, id) => {
  applyNotifications(announcements.clearOne(notifications, id), { broadcast: false });
  return snapshot();
});
ipcMain.handle('notifications-clear', async () => {
  applyNotifications(announcements.clearAll(notifications), { broadcast: false });
  return snapshot();
});
ipcMain.on('app-theme-get', event => { event.returnValue = appTheme.normalize(settings.appTheme); });

function syncAppTheme() {
  if (!historyWin || historyWin.isDestroyed()) return;
  const colors = appTheme.chrome(settings.appTheme);
  historyWin.setBackgroundColor(colors.background);
  // macOS uses native traffic lights; Electron exposes this setter only on
  // Windows/Linux. Calling it on a Mac rejected an already-saved preference.
  if (process.platform !== 'darwin' && typeof historyWin.setTitleBarOverlay === 'function') {
    historyWin.setTitleBarOverlay({ color: colors.background, symbolColor: colors.symbols, height: 60 });
  }
  historyWin.webContents.send('app-theme-changed', appTheme.normalize(settings.appTheme));
}

ipcMain.handle('settings-set', async (_e, patch) => {
  if (!patch || typeof patch !== 'object') return snapshot();

  // Appearance never rebuilds history or touches a live recording. A failed
  // write restores the in-memory preference as well as the renderer choice.
  if (Object.keys(patch).length === 1 && Object.hasOwn(patch, 'appTheme')) {
    const previous = settings.appTheme;
    settings.appTheme = appTheme.normalize(patch.appTheme);
    try { saveSettings(); } catch (error) { settings.appTheme = previous; throw error; }
    syncAppTheme();
    return { appTheme: settings.appTheme };
  }

  if (patch.dictateMode === 'ptt' || patch.dictateMode === 'toggle') {
    settings.dictateMode = patch.dictateMode;
    if (patch.dictateMode === 'toggle') pttReleasePending = false;
  }

  if (typeof patch.shortcut === 'string' && patch.shortcut.trim()) {
    const prev = settings.shortcut;
    const next = patch.shortcut.trim();
    if (sameShortcut(next, settings.pasteLastShortcut)) {
      return Object.assign(snapshot(), {
        shortcutError: formatShortcutLabel(next) + ' is already used to paste your last dictation.',
      });
    }
    if (process.platform === 'win32' && settings.gameShortcutEnabled && sameShortcut(next, settings.gameShortcut)) {
      return Object.assign(snapshot(), {
        shortcutError: formatShortcutLabel(next) + ' is already your game shortcut.',
      });
    }
    settings.shortcut = next;
    const res = tryRegisterDictationShortcut(next);
    // The picker reports a chord on key-down, so the keys are still held as
    // the new registration goes live. Treat them as held until the watcher
    // says otherwise; a hotkey auto-repeat arriving before it has even
    // started must not become a recording.
    if (res.ok) chordStaleHeld = true;
    if (!res.ok) {
      settings.shortcut = prev;
      tryRegisterDictationShortcut(prev);
      // Say which chord and why, not just "unavailable" -- a Windows-reserved
      // combination is indistinguishable from a broken app otherwise.
      return Object.assign(snapshot(), { shortcutError: res.reason });
    }
    // The chord the user just picked works, so any standing launch-time notice
    // about the old one is stale.
    hotkeyNotice = '';
    saveSettings();
  }

  if (typeof patch.pasteLastShortcut === 'string' && patch.pasteLastShortcut.trim()) {
    const prev = settings.pasteLastShortcut;
    const next = patch.pasteLastShortcut.trim();
    if (sameShortcut(next, settings.shortcut)) {
      return Object.assign(snapshot(), {
        shortcutError: formatShortcutLabel(next) + ' is already used for dictation.',
      });
    }
    if (process.platform === 'win32' && settings.gameShortcutEnabled && sameShortcut(next, settings.gameShortcut)) {
      return Object.assign(snapshot(), {
        shortcutError: formatShortcutLabel(next) + ' is already your game shortcut.',
      });
    }
    settings.pasteLastShortcut = next;
    const res = tryRegisterPasteLastShortcut(next);
    if (!res.ok) {
      settings.pasteLastShortcut = prev;
      tryRegisterPasteLastShortcut(prev);
      return Object.assign(snapshot(), { shortcutError: res.reason });
    }
    hotkeyNotice = '';
    saveSettings();
  }

  if (typeof patch.gameShortcut === 'string' && patch.gameShortcut.trim()) {
    const prev = settings.gameShortcut;
    const next = patch.gameShortcut.trim();
    const res = tryRegisterGameShortcut(next);
    if (!res.ok) {
      tryRegisterGameShortcut(prev);
      return Object.assign(snapshot(), { shortcutError: res.reason });
    }
    settings.gameShortcut = next;
    // Picked on key-down: the key is still held as its watcher starts.
    gameStaleHeld = true;
    hotkeyNotice = '';
    saveSettings();
  }

  if (typeof patch.gameShortcutEnabled === 'boolean' && patch.gameShortcutEnabled !== (settings.gameShortcutEnabled === true)) {
    settings.gameShortcutEnabled = patch.gameShortcutEnabled;
    const res = tryRegisterGameShortcut(settings.gameShortcut);
    if (!res.ok) {
      // Taken by dictation, paste last or another app: stay off and say why.
      settings.gameShortcutEnabled = false;
      tryRegisterGameShortcut(settings.gameShortcut);
      return Object.assign(snapshot(), { shortcutError: res.reason });
    }
    hotkeyNotice = '';
    saveSettings();
  }

  const boolKeys = [
    'launchAtLogin', 'alwaysShowFlowBar', 'showInTaskbar',
    'soundsEnabled', 'suggestionsEnabled', 'muteMusicWhileDictating',
    'verbatimMode', 'verbatimDictionary', 'numbersAsDigits', 'autoCleanup', 'autoAddToDictionary',
    'spokenCorrections',
  ];
  for (const key of boolKeys) {
    if (typeof patch[key] === 'boolean') settings[key] = patch[key];
  }
  // An old settings file may still carry the cloud switch; it no longer does
  // anything, so a stale true must not linger.
  delete settings.cloudTranscription;
  if (settings.autoAddToDictionary === false) stopCorrectionLearning();

  if (typeof patch.flowBarStyle === 'string') {
    settings.flowBarStyle = flowBar.normalizeStyle(patch.flowBarStyle);
  }
  if (typeof patch.flowBarMotion === 'string') {
    settings.flowBarMotion = normalizeFlowMotion(patch.flowBarMotion);
  }

  // The Whisper fine-tune is gone with the old engines; an old file may
  // still carry the switch, which is now inert.
  delete settings.useTunedModel;

  const nextAsrEngine = 'voz';
  const nextAsrDevice = 'cpu';
  if (nextAsrEngine !== settings.asrEngine || nextAsrDevice !== settings.asrDevice) {
    settings.asrEngine = nextAsrEngine;
    settings.asrDevice = nextAsrDevice;
    engineError = '';
  }

  // Turning either kind of keeping off means those recordings go, not just
  // the collecting. Training pairs are the training toggle's; playback
  // recordings are the other's, and with both off nothing is kept at all.
  if (typeof patch.keepTrainingAudio === 'boolean') {
    settings.keepTrainingAudio = patch.keepTrainingAudio;
    if (!patch.keepTrainingAudio) trainingError = corpus.clearCorpus() ? '' : 'Some training recordings could not be deleted. Close other apps using them and try again.';
    pruneRecordings();
  }
  if (typeof patch.keepRecordings === 'boolean') {
    settings.keepRecordings = patch.keepRecordings;
    pruneRecordings();
  }

  if (patch.modelUnloadMinutes !== undefined) {
    settings.modelUnloadMinutes = normalizeModelUnloadMinutes(patch.modelUnloadMinutes);
    scheduleModelUnload();
  }

  // The list is the setting; a plain string from an older renderer is a
  // list of one. The scalar shadows the first entry either way.
  if (Array.isArray(patch.dictationLanguages)) {
    settings.dictationLanguages = asr.normalizeDictationLanguages(patch.dictationLanguages);
    settings.dictationLanguage = settings.dictationLanguages[0];
  } else if (typeof patch.dictationLanguage === 'string') {
    settings.dictationLanguages = asr.normalizeDictationLanguages(patch.dictationLanguage);
    settings.dictationLanguage = settings.dictationLanguages[0];
  }
  syncDictationLanguages();

  if (typeof patch.displayName === 'string') {
    settings.displayName = patch.displayName.trim().slice(0, 40);
    settings.displayNameFrom = '';
  }

  if (typeof patch.microphone === 'string' && patch.microphone) {
    settings.microphone = patch.microphone;
  }

  if (patch.writingStyles && typeof patch.writingStyles === 'object') {
    settings.writingStyles = style.normalizeWritingStyles(
      Object.assign({}, settings.writingStyles, patch.writingStyles)
    );
  }

  const previousTheme = settings.appTheme;
  if (Object.hasOwn(patch, 'appTheme')) settings.appTheme = appTheme.normalize(patch.appTheme);
  try { saveSettings(); } catch (error) { settings.appTheme = previousTheme; throw error; }
  if (settings.appTheme !== previousTheme) syncAppTheme();
  applySystemSettings();
  // Idle applies the show/hide preference; active pages keep their recording,
  // result text and editable entry while receiving the changed preferences.
  sendOverlay({ mode: mode === 'idle' ? 'idle' : undefined });
  broadcast();
  return snapshot();
});
ipcMain.handle('history-copy', async (_e, id, which) => {
  const entry = history.entries.find((x) => x.id === id);
  if (!entry) return false;
  if (which === 'polished') {
    if (!entry.polished || !entry.polished.text) return false;
    clipboard.writeText(entry.polished.text);
    return true;
  }
  clipboard.writeText(entry.text || '');
  return true;
});
ipcMain.handle('history-delete', async (_e, id) => {
  const entries = history.entries.filter((x) => x.id !== id);
  if (entries.length !== history.entries.length) {
    // Explicit deletion retains its existing semantics. Automatic retention
    // never calls this handler or removes learned/training data.
    saveHistory({ ...history, entries });
    if (retryEntryOwner === id) {
      corpus.clearRetry();
      retryEntryOwner = null;
    }
    corpus.discard(id);
    broadcast();
  }
  return true;
});
ipcMain.handle('history-edit', async (_e, id, text) => {
  const entry = history.entries.find((x) => x.id === id);
  if (!entry) return { ok: false, learned: [] };
  const next = String(text || '');
  if (next === entry.text) return { ok: true, learned: [] };
  const updated = { ...entry, original: entry.original || entry.text };

  // Retraction still runs: rules an older build learned silently must come
  // back out when the user corrects that transcript again. New pairs only get
  // proposed, so editing a transcript no longer rewrites every later one.
  const kept = dict.retractPairs(dictionary.phrases, entry.learnedPairs);
  dictionary.phrases = kept;
  dictionary.variants = dict.syncVariants(kept, dictionary.variants);
  const proposals = dict.propose(updated.original, next, kept, dictionary.pending, entry.text);
  if (proposals.length) {
    dictionary.pending = dict.queuePending(dictionary.pending, proposals);
  }
  updated.learnedPairs = [];
  updated.text = next;
  updated.editRevision = (entry.editRevision || 0) + 1;
  // The user just supplied ground truth for this clip. If the audio is still
  // around, that is a labelled training pair.
  if (settings.keepTrainingAudio) {
    corpus.promote(entry.id, {
      text: next,
      asr: updated.original,
      learned: [],
      ts: entry.ts,
    });
  }
  saveDict();
  saveHistory({ ...history, entries: history.entries.map(item => item === entry ? updated : item) });
  broadcast();
  return { ok: true, learned: [], proposed: proposals };
});
ipcMain.handle('dict-upsert', async (_e, from, to, meta) => {
  const previous = dictionary;
  const renameFrom = String(meta && meta.renameFrom || '').trim();
  let base = dictionary;
  if (renameFrom && renameFrom.toLowerCase() !== String(from).trim().toLowerCase()) {
    if (!dictionary.phrases.some(p => p.from.toLowerCase() === renameFrom.toLowerCase())) {
      return { ok: false, error: 'That entry no longer exists.' };
    }
    if (dictionary.phrases.some(p => p.from.toLowerCase() === String(from).trim().toLowerCase())) {
      return { ok: false, error: 'That entry already exists. Choose another name.' };
    }
    base = Object.assign({}, dictionary, dict.removePhrase(dictionary.phrases, dictionary.variants, renameFrom));
  }
  const result = dict.upsertPhrase(
    base.phrases, from, to, base.variants,
    Object.assign({}, meta || {}, { blocked: dictionary.blocked })
  );
  if (!result.ok) return { ok: false, error: result.error };
  dictionary = Object.assign({}, base, { phrases: result.phrases, variants: result.variants });
  try { saveDict(); } catch (err) {
    dictionary = previous;
    vocabularyDirty = true;
    return { ok: false, error: 'Could not save that entry. Your original entry was kept.' };
  }
  broadcast();
  return { ok: true };
});
ipcMain.handle('dict-pending-accept', async (_e, from) => {
  const proposal = dict.findPending(dictionary.pending, from);
  if (!proposal) return { ok: false, error: 'That suggestion is no longer queued.' };
  const result = dict.upsertPhrase(
    dictionary.phrases, proposal.from, proposal.to, dictionary.variants,
    { kind: 'mapping', source: 'learned', blocked: dictionary.blocked }
  );
  if (!result.ok) {
    // A proposal that can no longer be added is not worth keeping around.
    dictionary.pending = dict.removePending(dictionary.pending, from);
    saveDict();
    broadcast();
    return { ok: false, error: result.error };
  }
  dictionary.phrases = result.phrases;
  dictionary.variants = result.variants;
  dictionary.pending = dict.removePending(dictionary.pending, from);
  saveDict();
  broadcast();
  return { ok: true };
});
ipcMain.handle('dict-pending-dismiss', async (_e, from) => {
  dictionary.pending = dict.removePending(dictionary.pending, from);
  saveDict();
  broadcast();
  return true;
});
ipcMain.handle('dict-delete', async (_e, from) => {
  // Deleting a term also drops the spellings generated from it.
  const result = dict.removePhrase(dictionary.phrases, dictionary.variants, from);
  dictionary.phrases = result.phrases;
  dictionary.variants = result.variants;
  saveDict();
  broadcast();
  return true;
});
ipcMain.handle('training-clear', async () => {
  const ok = corpus.clearCorpus();
  trainingError = ok ? '' : 'Some training recordings could not be deleted. Close other apps using them and try again.';
  broadcast();
  return snapshot();
});
ipcMain.handle('recordings-clear', async () => {
  if (mode === 'arming' || mode === 'recording' || mode === 'transcribing' || retryingEntryId || recoveringId) {
    return { ok: false, reason: 'Finish the current dictation or retry before deleting recordings.' };
  }
  const recordingsCleared = corpus.clearRecordings();
  // Shelved clips are kept by the same setting, so the same button deletes them.
  const recoveriesCleared = corpus.clearRecoveries();
  const retryCleared = !corpus.hasRetry() || corpus.clearRetry();
  recordingsError = recordingsCleared && recoveriesCleared && retryCleared ? '' : 'Some recordings could not be deleted. Close other apps using them and try again.';
  sendOverlay();
  broadcast();
  const ok = recordingsCleared && recoveriesCleared && retryCleared;
  return {
    ok,
    snapshot: snapshot(),
    reason: ok ? '' : 'Some recordings could not be deleted. Try again.',
  };
});
// The recording behind a dictation, for the card to play. Bytes rather than
// a path: the window is not allowed at the data folder, and a WAV of a few
// hundred kilobytes is nothing to hand over.
ipcMain.handle('history-audio', async (_e, id) => {
  const entry = history.entries.find((x) => x.id === id);
  const file = entry ? corpus.recordingPath(entry.id) : null;
  if (!file) return { ok: false, reason: 'No recording kept for this dictation.' };
  try {
    return { ok: true, bytes: fs.readFileSync(file), seconds: corpus.wavSeconds(file) };
  } catch (_) {
    return { ok: false, reason: 'The recording could not be read.' };
  }
});
ipcMain.handle('history-audio-save', async (_e, id) => {
  const entry = history.entries.find((x) => x.id === id);
  const file = entry ? corpus.recordingPath(entry.id) : null;
  if (!file) return { ok: false, reason: 'No recording kept for this dictation.' };
  return saveWavDialog(file);
});

async function saveWavDialog(file) {
  const stamp = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const name = 'Vell ' + stamp.getFullYear() + '-' + pad(stamp.getMonth() + 1) + '-' + pad(stamp.getDate())
    + ' ' + pad(stamp.getHours()) + '-' + pad(stamp.getMinutes()) + '-' + pad(stamp.getSeconds()) + '.wav';
  let target;
  try {
    const picked = await dialog.showSaveDialog(historyWin && !historyWin.isDestroyed() ? historyWin : undefined, {
      title: 'Save recording',
      defaultPath: path.join(app.getPath('downloads'), name),
      filters: [{ name: 'WAV audio', extensions: ['wav'] }],
    });
    if (picked.canceled || !picked.filePath) return { ok: false, cancelled: true };
    target = picked.filePath;
    fs.copyFileSync(file, target);
    // Windows copies the recording's old modified time too. Mark the export
    // as saved now so it sorts as recent in whichever folder the user chose.
    const savedAt = new Date();
    fs.utimesSync(target, savedAt, savedAt);
  } catch (err) {
    return { ok: false, reason: 'The recording could not be saved: ' + ((err && err.message) || 'unknown error') };
  }
  return { ok: true, path: target };
}
ipcMain.handle('history-retry', async (_e, id) => retryEntry(id));

// --- the recovery shelf -------------------------------------------------

ipcMain.handle('recovery-audio', async (_e, id) => {
  const file = corpus.recoveryPath(id);
  if (!file) return { ok: false, reason: 'That recording is no longer here.' };
  try {
    return { ok: true, bytes: fs.readFileSync(file), seconds: corpus.wavSeconds(file) };
  } catch (_) {
    return { ok: false, reason: 'The recording could not be read.' };
  }
});
ipcMain.handle('recovery-save', async (_e, id) => {
  const file = corpus.recoveryPath(id);
  if (!file) return { ok: false, reason: 'That recording is no longer here.' };
  return saveWavDialog(file);
});
ipcMain.handle('recovery-transcribe', async (_e, id) => recoverRecording(id));
ipcMain.handle('recovery-delete', async (_e, id) => {
  if (recoveringId === id) return { ok: false, reason: 'That recording is being recovered.' };
  const removed = corpus.dropRecovery(id);
  broadcast();
  return { ok: removed, snapshot: snapshot(), reason: removed ? '' : 'The recording could not be deleted.' };
});
// A Vell restarted as administrator (restart-as-admin) starts while the one
// that asked for it is still closing, and that one holds the single-instance
// lock until it is gone: taken now, the lock would be refused and this copy
// would quit, leaving no Vell at all. So the old process is waited out
// first. Blocking, since the lock is taken right here as the file loads, and
// bounded: a copy that never exits costs this launch 15 s, not forever.
//
// Once the elevated copy runs, an ordinary launch -- from Start, say -- is
// refused the lock and quits without a word, and the elevated copy gets no
// second-instance event to open its window on (electron#35681: the lock's
// DACL and UIPI between the two levels). Left as it is.
const afterPid = elevation.afterPid(process.argv);
if (afterPid && afterPid !== process.pid) {
  elevation.waitForExit(afterPid, { isAlive: elevation.processAlive, sleep: elevation.sleepSync, timeoutMs: 15000 });
}
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (app.isReady()) openHistory();
    else app.once('ready', () => openHistory());
  });
  // macOS never starts a second copy: opening Vell again from Finder,
  // Launchpad or Spotlight sends the running one 'activate' instead (Electron
  // emits it nowhere else), so that is where the window comes back. With no
  // Dock icon (mac-shell.js bringForward) this is the only way back in apart
  // from the menu bar icon.
  app.on('activate', () => {
    if (app.isReady() && !isQuitting) openHistory();
  });

  app.whenReady().then(async () => {
    initPaths();
    loadStores();
    // Retry belongs to a running session, never to a new launch's paste target.
    // A clip that survived to here means the last session never ended cleanly,
    // so it is shelved for recovery instead of deleted.
    rescueUnfinishedClip();
    corpus.clearRetry();
    // Recordings age out on the clock, not on dictation, so a launch after a
    // quiet fortnight is where the old ones go.
    pruneRecordings();
    loadAsrSetupState();
    tidyModelStorage();
    deliverAnnouncements();
    const ses = require('electron').session.defaultSession;
    // The microphone, and nothing else, for the app's own pages. Any other
    // page (none should ever load) and any camera request is refused.
    ses.setPermissionRequestHandler((wc, permission, cb, details) => {
      const url = (details && details.requestingUrl) || (wc && typeof wc.getURL === 'function' ? wc.getURL() : '');
      const types = (details && Array.isArray(details.mediaTypes)) ? details.mediaTypes : [];
      cb(permission === 'media' && isAppPage(url) && types.every((t) => t === 'audio'));
    });
    ses.setPermissionCheckHandler((_wc, permission, origin, details) => {
      const url = details && details.requestingUrl;
      const own = url ? isAppPage(url) : /^file:/i.test(String(origin || ''));
      if (!own) return false;
      return !(permission === 'media' && details && details.mediaType === 'video');
    });
    const appMenu = macShell.applicationMenuTemplate(process.platform);
    Menu.setApplicationMenu(appMenu ? Menu.buildFromTemplate(appMenu) : null);
    createOverlay();
    createHistoryWindow();
    createTray();
    registerHotkeys();
    applySystemSettings();
    startHwndPoll();
    macShell.askForMicrophone(require('electron').systemPreferences, process.platform);
    // Compile the Win32 helper now, while nothing is waiting on it, so the
    // first paste does not pay for it.
    warmPsServers();
    // Whether this Vell runs as administrator, for Settings and the admin-app note.
    checkElevation();
    // Resolution, scale and taskbar changes all come through metrics-changed;
    // plugging a monitor in or out does not, and that is the case that used to
    // leave the bar parked on a screen the user no longer had.
    screen.on('display-metrics-changed', scheduleOverlayReflow);
    screen.on('display-added', scheduleOverlayReflow);
    screen.on('display-removed', scheduleOverlayReflow);
    // Coming back from sleep or the lock screen is when the bar has been
    // found deaf to the mouse; see rearmOverlayAfterWake.
    powerMonitor.on('resume', () => rearmOverlayAfterWake('resume'));
    powerMonitor.on('unlock-screen', () => rearmOverlayAfterWake('unlock-screen'));
    powerMonitor.on('suspend', () => pauseOverlayHealth('suspend'));
    powerMonitor.on('lock-screen', () => pauseOverlayHealth('lock-screen'));
    // Warm the Voz model in the background once it is on disk, so the first
    // dictation does not pay the compile cost with the microphone already
    // open. Fire and forget: a failure surfaces on first transcribe instead.
    startSidecar();
  });

  app.on('before-quit', (event) => {
    if (mediaShutdownDone) return;
    event.preventDefault();
    if (isQuitting) return;
    isQuitting = true;
    advanceRecordingSession();
    if (mode === 'arming' || mode === 'recording' || mode === 'transcribing') {
      mode = 'cancel';
      sendOverlay({ mode: 'cancel', text: 'Cancelled' });
    }
    if (asrSetupController) asrSetupController.abort();
    backgroundMedia.close().finally(() => {
      mediaShutdownDone = true;
      app.quit();
    });
  });

  app.on('will-quit', () => {
    stopCorrectionLearning();
    if (clipboardPaste) clipboardPaste.restore();
    globalShortcut.unregisterAll();
    pttReleasePending = false;
    // A watcher left running would outlive the app and hold a powershell process.
    stopChordWatch();
    stopGameWatch();
    stopForegroundWatch();
    stopPsServers();
    stopOverlayDrag(false);
    clearArmingTimer();
    if (overlayRecreateTimer) clearTimeout(overlayRecreateTimer);
    if (overlayReflowTimer) clearTimeout(overlayReflowTimer);
    if (hwndTimer) clearInterval(hwndTimer);
    clearModelUnload();
    corpus.clearRetry();
  });
}
