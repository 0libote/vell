'use strict';

// What the bell in the title bar has to say.
//
// Two things feed it. The CATALOG below ships inside the app and describes
// what is new about the build the user is running -- a new engine, a new
// language model, a feature that did not exist before. Runtime events (an
// update finished downloading) are added with note() as they happen. Both end
// up in the same store, so the panel, the badge and "clear all" only ever deal
// with one kind of thing.
//
// Everything here is pure: a state object goes in, a new state object comes
// out. The main process owns reading and writing the file; this owns the rules.

// Group related release improvements into useful summaries, including fixes
// that change everyday dictation or recovery. Keep the full release notes in
// sync with these words so the bell and GitHub describe the same build.
//
// To announce something, add an entry with `since` set to the version it ships
// in. Ids are permanent: a delivered id is remembered forever so a cleared
// notification cannot come back, which also means an id must never be reused
// for different news.
const CATALOG = [
  {
    id: 'vell-local-1-0-0',
    since: '1.0.0',
    kind: 'feature',
    title: 'Welcome to Vell',
    body: 'Fast, private, on-device voice dictation. No account, no word limits. Pick a speech model under Speech engines to get started.',
    action: { settings: 'speech-engines' },
  },
];

const KINDS = new Set(['feature', 'model', 'engine', 'update', 'credits', 'paste']);

// Versions here are the app's own, so they are dotted numbers with an
// occasional prerelease tail. The tail is dropped rather than ordered: it only
// has to decide whether news has shipped yet, and 1.0.14-beta.1 is close
// enough to 1.0.14 for that.
function versionParts(value) {
  const main = String(value == null ? '' : value).trim().split(/[-+]/)[0];
  return main.split('.').map((part) => {
    const n = parseInt(part, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const l = left[i] || 0;
    const r = right[i] || 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

function normalizeKind(value) {
  const kind = text(value).trim().toLowerCase();
  return KINDS.has(kind) ? kind : 'feature';
}

// An entry the app invented at runtime rather than one it shipped with. It
// carries its own words because there is no catalog row to look them up in.
function normalizeInline(value) {
  if (!value || typeof value !== 'object') return null;
  const title = text(value.title).trim();
  if (!title) return null;
  const inline = {
    kind: normalizeKind(value.kind),
    title,
    body: text(value.body).trim(),
  };
  if (value.action && typeof value.action === 'object') {
    // A settings pane, or a view of the window: Writing style and the
    // dictionary are views, not settings panes.
    const settings = text(value.action.settings).trim();
    const view = text(value.action.view).trim();
    if (settings) inline.action = { settings };
    else if (view) inline.action = { view };
  }
  return inline;
}

// The store has been through JSON and a file the user can edit, so nothing in
// it is trusted. A record that cannot be read is dropped, not repaired: the
// worst it costs is one notification.
function normalizeState(raw) {
  const state = { seenVersion: '', items: {} };
  if (!raw || typeof raw !== 'object') return state;
  state.seenVersion = text(raw.seenVersion).trim();
  const items = raw.items && typeof raw.items === 'object' ? raw.items : {};
  for (const id of Object.keys(items)) {
    const record = items[id];
    if (!id || !record || typeof record !== 'object') continue;
    const ts = num(record.ts, 0);
    if (!ts) continue;
    const next = {
      ts,
      read: !!record.read,
      cleared: !!record.cleared,
    };
    const inline = normalizeInline(record.inline);
    if (inline) next.inline = inline;
    state.items[id] = next;
  }
  return state;
}

function cloneState(state) {
  const items = {};
  for (const id of Object.keys(state.items)) {
    items[id] = Object.assign({}, state.items[id]);
  }
  return { seenVersion: state.seenVersion, items };
}

// Which catalog rows count as news for this run.
//
// A store that has never been written belongs to a fresh install, and a fresh
// install has no history to catch up on -- everything in the app is new to it
// at once, which is not news, it is the app. Only what ships *in this version*
// is worth saying, and that is the same thing an existing user sees when they
// update into it.
//
// After that first run the rule is the ordinary one: anything that shipped
// after the version last seen, up to the version running now. Skipping a
// release still delivers what happened in between, because the comparison is
// against what the user last ran, not against the previous release.
//
// A rebuild of the same version can add catalog rows. Those still count as
// news if this launch has never stored them — otherwise a 1.0.19 rebuild
// that added announcements would stay silent for anyone who had already
// opened 1.0.19 once.
function isNews(entry, seenVersion, version) {
  if (compareVersions(entry.since, version) > 0) return false;
  if (!seenVersion) return compareVersions(entry.since, version) === 0;
  if (compareVersions(entry.since, seenVersion) > 0) return true;
  return compareVersions(entry.since, version) === 0
    && compareVersions(seenVersion, version) === 0;
}

// Fold the catalog into the store for the version now running. Ids already in
// the store are left exactly as they are, so a notification that was read or
// cleared stays that way across restarts and downgrades.
function deliver(state, options) {
  const opts = options || {};
  const catalog = Array.isArray(opts.catalog) ? opts.catalog : CATALOG;
  const version = text(opts.version).trim();
  const now = num(opts.now, Date.now());
  const next = cloneState(normalizeState(state));
  let changed = false;

  for (const entry of catalog) {
    if (!entry || !entry.id) continue;
    if (next.items[entry.id]) continue;
    if (!isNews(entry, next.seenVersion, version)) continue;
    next.items[entry.id] = { ts: now, read: false, cleared: false };
    changed = true;
  }

  if (version && next.seenVersion !== version) {
    next.seenVersion = version;
    changed = true;
  }
  return { state: next, changed };
}

// A notification the app raised itself. Called on every broadcast of the event
// behind it, so it has to be idempotent: the id carries the version or the
// subject it is about, and a second call with the same id changes nothing.
function note(state, entry, now) {
  const next = cloneState(normalizeState(state));
  const id = entry && text(entry.id).trim();
  const inline = normalizeInline(entry);
  if (!id || !inline) return { state: next, changed: false };
  if (next.items[id]) return { state: next, changed: false };
  next.items[id] = { ts: num(now, Date.now()), read: false, cleared: false, inline };
  return { state: next, changed: true };
}

// What the panel draws: newest first, cleared ones gone. A stored id with no
// catalog row and no inline copy is skipped rather than shown blank -- that is
// what a catalog entry retired in a later build looks like.
function list(state, catalog) {
  const rows = Array.isArray(catalog) ? catalog : CATALOG;
  const byId = new Map(rows.filter((e) => e && e.id).map((e) => [e.id, e]));
  const clean = normalizeState(state);
  const out = [];
  for (const id of Object.keys(clean.items)) {
    const record = clean.items[id];
    if (record.cleared) continue;
    const source = record.inline || byId.get(id);
    if (!source) continue;
    const item = {
      id,
      kind: normalizeKind(source.kind),
      title: text(source.title),
      body: text(source.body),
      ts: record.ts,
      unread: !record.read,
    };
    if (source.action && source.action.settings) {
      item.action = { settings: source.action.settings };
    } else if (source.action && source.action.view) {
      item.action = { view: source.action.view };
    }
    out.push(item);
  }
  out.sort((a, b) => (b.ts - a.ts) || a.id.localeCompare(b.id));
  return out;
}

function unreadCount(items) {
  return (Array.isArray(items) ? items : []).filter((item) => item && item.unread).length;
}

function markAllRead(state) {
  const next = cloneState(normalizeState(state));
  let changed = false;
  for (const id of Object.keys(next.items)) {
    if (next.items[id].read || next.items[id].cleared) continue;
    next.items[id].read = true;
    changed = true;
  }
  return { state: next, changed };
}

// Clearing keeps the id. The record is the only memory that this notification
// was ever delivered, and dropping it would put the notification back on the
// next launch.
function clearOne(state, id) {
  const next = cloneState(normalizeState(state));
  const key = text(id).trim();
  const record = key && next.items[key];
  if (!record || record.cleared) return { state: next, changed: false };
  record.cleared = true;
  record.read = true;
  return { state: next, changed: true };
}

function clearAll(state) {
  const next = cloneState(normalizeState(state));
  let changed = false;
  for (const id of Object.keys(next.items)) {
    if (next.items[id].cleared) continue;
    next.items[id].cleared = true;
    next.items[id].read = true;
    changed = true;
  }
  return { state: next, changed };
}

// The one runtime notification the app raises today. Only a finished download
// is stored: a download in progress is drawn live from the update status and
// forgotten when it ends, because a row that says "43%" is not news worth
// keeping. The panel offers a restart on this row while the update is still
// waiting; the words below cover the case where it is not (the row outlives
// the install, and then just records that it happened).
function updateReadyEntry(version) {
  const v = text(version).trim();
  if (!v) return null;
  return {
    id: 'update-ready:' + v,
    kind: 'update',
    title: 'Vell ' + v + ' is ready',
    body: 'The update is downloaded. Restart Vell to finish installing it, or it installs when you next quit.',
    action: { settings: 'system' },
  };
}

// Vell has no automatic updates: a newer release is news the moment it is
// found, and it is fetched by hand, not downloaded by the app.
function updateAvailableEntry(version) {
  const v = text(version).trim();
  if (!v) return null;
  return {
    id: 'update-available:' + v,
    kind: 'update',
    title: 'Vell ' + v + ' is out',
    body: 'Fetch the new release and drag it over this copy in Applications.',
    action: { settings: 'system' },
  };
}

module.exports = {
  CATALOG,
  compareVersions,
  normalizeState,
  deliver,
  note,
  list,
  unreadCount,
  markAllRead,
  clearOne,
  clearAll,
  updateReadyEntry,
  updateAvailableEntry,
};
