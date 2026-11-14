'use strict';

// Exercise the actual System settings DOM using an isolated Electron profile.
// Main-process settings are deliberately mocked: this must never change the
// tester's Windows startup entry, access a microphone, or start dictation.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'voxden-system-ui-')));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error('System settings UI timed out'); app.exit(1); }, 45000);
const errors = [];
const saves = [];
let rejectSave = false;
let notificationReads = 0;
let snapshot = {
  displayName: 'Alex', shortcutLabel: 'Ctrl+Shift+Space', shortcut: 'CommandOrControl+Shift+Space',
  dictateMode: 'toggle',
  shortcuts: [{ id: 's1', accelerator: 'CommandOrControl+Shift+Space', label: 'Ctrl+Shift+Space', mode: 'toggle' }],
  entries: [], phrases: [],
  notifications: [], pendingPhrases: [], writingStyles: {},
  launchAtLogin: false, alwaysShowFlowBar: false, showInTaskbar: false,
  flowBarStyle: 'island', flowBarMotion: 'full', soundsEnabled: false,
  updateStatus: 'idle', appVersion: '2.1.1', flowBarMoved: true,
};
const shortcutLabelFor = accel => String(accel || '').replace(/CommandOrControl/g, 'Ctrl').replace(/Super/g, 'Win');
const syncPrimaryShortcutScalars = () => {
  const primary = (snapshot.shortcuts && snapshot.shortcuts[0]) || null;
  if (primary) {
    snapshot.shortcut = primary.accelerator;
    snapshot.shortcutLabel = primary.label || shortcutLabelFor(primary.accelerator);
    snapshot.dictateMode = primary.mode;
  }
};

app.whenReady().then(async () => {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ipcMain.handle('app-load', () => snapshot);
  ipcMain.handle('settings-set', (_event, patch) => {
    saves.push(patch);
    if (rejectSave) { rejectSave = false; throw new Error('Expected System preference test failure'); }
    if (patch && typeof patch === 'object' && patch.shortcutUpdate && typeof patch.shortcutUpdate === 'object') {
      const update = patch.shortcutUpdate;
      const list = Array.isArray(snapshot.shortcuts) ? snapshot.shortcuts.map(s => ({ ...s })) : [];
      const at = list.findIndex(s => s.id === update.id);
      if (at >= 0) {
        if (typeof update.accelerator === 'string' && update.accelerator.trim()) {
          list[at].accelerator = update.accelerator.trim();
          list[at].label = shortcutLabelFor(list[at].accelerator);
        }
        if (typeof update.mode === 'string' && ['toggle', 'ptt', 'both'].includes(update.mode)) list[at].mode = update.mode;
        snapshot = { ...snapshot, shortcuts: list };
        syncPrimaryShortcutScalars();
        return snapshot;
      }
    }
    if (patch && typeof patch === 'object' && typeof patch.shortcutAdd === 'string' && patch.shortcutAdd.trim()) {
      const accel = patch.shortcutAdd.trim();
      const list = Array.isArray(snapshot.shortcuts) ? snapshot.shortcuts.map(s => ({ ...s })) : [];
      const id = 's' + (list.length + 1) + '-' + saves.length;
      list.push({ id, accelerator: accel, label: shortcutLabelFor(accel), mode: 'toggle' });
      snapshot = { ...snapshot, shortcuts: list };
      syncPrimaryShortcutScalars();
      return snapshot;
    }
    if (patch && typeof patch === 'object' && typeof patch.shortcutRemove === 'string' && patch.shortcutRemove) {
      const list = (Array.isArray(snapshot.shortcuts) ? snapshot.shortcuts : []).filter(s => s.id !== patch.shortcutRemove);
      if (list.length !== (snapshot.shortcuts || []).length) {
        snapshot = { ...snapshot, shortcuts: list };
        syncPrimaryShortcutScalars();
        return snapshot;
      }
    }
    snapshot = { ...snapshot, ...patch };
    return snapshot;
  });
  ipcMain.handle('flow-bar-reset', () => { snapshot = { ...snapshot, flowBarMoved: false }; return snapshot; });
  ipcMain.handle('update-check', () => ({ state: 'idle' }));
  ipcMain.handle('notifications-read', () => { notificationReads++; return snapshot; });
  ipcMain.handle('toggle', () => { assert.fail('System controls must never start dictation'); });

  const win = new BrowserWindow({
    show: false, width: 1120, height: 760, useContentSize: true,
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#101113', symbolColor: '#a3ada6', height: 60 },
    webPreferences: {
      preload: path.join(__dirname, '../src/preload.js'), contextIsolation: true,
      sandbox: false, backgroundThrottling: false, offscreen: true,
    },
  });
  win.webContents.on('render-process-gone', (_event, details) => errors.push('Renderer exited: ' + details.reason));
  win.webContents.on('console-message', event => {
    if ((event.level === 'error' || Number(event.level) >= 3)
        && !/Content-Security-Policy|Expected System preference test failure/.test(event.message)) errors.push(event.message);
  });
  await win.loadFile(path.join(__dirname, '../src/app.html'));
  const run = code => win.webContents.executeJavaScript(code);
  await run(`window.systemMicRequests = 0;
    navigator.mediaDevices.getUserMedia = async () => { systemMicRequests++; throw new Error('No test microphone'); };
    navigator.mediaDevices.enumerateDevices = async () => []; true`);
  const waitFor = async (expression, message) => {
    const until = Date.now() + 2500;
    do { if (await run(expression)) return; await pause(25); } while (Date.now() < until);
    assert.fail(message + ': ' + expression);
  };
  const click = async selector => {
    const point = await run(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await pause(40);
  };
  const openSystem = async () => {
    await run(`openSettingsTarget('system'); true`);
    await pause(220);
    assert.strictEqual(await run(`document.querySelector('.settings-panel[data-cat="system"]').hidden`), false);
    assert.strictEqual(await run(`document.getElementById('notif-btn').disabled`), true, 'the notification bell is disabled behind Settings');
    await click('#notif-btn');
    assert.strictEqual(await run(`document.getElementById('notif-panel').hidden`), true, 'clicking the disabled bell never opens a hidden panel');
    assert.strictEqual(notificationReads, 0, 'Settings must not mark unseen notifications as read');
  };
  const checkFlag = async (key, id, value) => {
    await click('.settings-cat[data-cat="' + (key === 'alwaysShowFlowBar' ? 'display' : 'system') + '"]');
    if (key === 'alwaysShowFlowBar') await openDisplayOptions();
    if (snapshot[key] !== value) {
      await click(`#${id} + .toggle-track`);
      await waitFor(`document.getElementById('${id}').checked === ${value}`, key + ' control should match saved value');
    }
    assert.strictEqual(snapshot[key], value, key + ' saves via IPC');
  };
  const openDisplayOptions = async () => {
    await click('.settings-cat[data-cat="display"]');
    if (!(await run(`document.getElementById('display-more-options').open`))) await click('#display-more-options > summary');
    assert.strictEqual(await run(`document.getElementById('display-more-options').open`), true);
  };
  const dragResults = [];
  await waitFor(`lastPayload && lastPayload.displayName === 'Alex'`, 'initial settings load');
  // The page has one delayed startup device-list refresh; allow that isolated,
  // rejected probe to finish before attributing requests to System controls.
  await pause(1400);
  await run('systemMicRequests = 0; true');
  assert.strictEqual(await run(`document.getElementById('display-more-options').open`), false, 'optional display controls start collapsed');
  for (const id of ['flow-style-options', 'set-always-flow', 'flow-motion-select', 'flow-bar-reset']) {
    assert.strictEqual(await run(`document.getElementById('${id}').closest('.settings-panel').dataset.cat`), 'display', id + ' lives in Display');
  }
  assert.deepStrictEqual(await run(`Array.from(document.querySelectorAll('[data-cat="system"].settings-panel .setting-label'), el => el.textContent)`),
    ['Launch at login', 'Show app in taskbar', 'Run as administrator'], 'System contains only startup, window and updates');
  assert.strictEqual(await run(`document.querySelectorAll('.app-theme-card[role="radio"]').length`), 2, 'Display offers Voxden and White themes');
  for (const launchAtLogin of [false, true]) {
    for (const alwaysShowFlowBar of [false, true]) {
      await openSystem();
      await checkFlag('launchAtLogin', 'set-launch-login', launchAtLogin);
      await checkFlag('alwaysShowFlowBar', 'set-always-flow', alwaysShowFlowBar);

      for (const style of ['orb', 'island']) {
        await click(`.flow-style-card[data-flow-style="${style}"]`);
        await waitFor(`document.querySelector('.flow-style-card[data-flow-style="${style}"]').getAttribute('aria-checked') === 'true'`, 'style stays selectable');
        assert.strictEqual(snapshot.flowBarStyle, style);
      }
      // The last click leaves the pointer on the Island card, so its hover
      // state is part of this: the artwork must neither animate nor move.
      const islandPreview = () => run(`(() => {
        const cap = document.querySelector('.flow-preview-island-cap'), box = cap.getBoundingClientRect();
        return { transform: getComputedStyle(cap).transform, width: box.width, height: box.height,
          animations: document.getAnimations().filter(a => a.effect && a.effect.target && a.effect.target.closest('.flow-preview-island')).length };
      })()`);
      const before = await islandPreview();
      await pause(130);
      const flags = JSON.stringify({ launchAtLogin, alwaysShowFlowBar });
      assert.strictEqual(before.animations, 0, 'Island preview runs no animation or transition with flags ' + flags);
      assert.deepStrictEqual(await islandPreview(), before, 'Island preview stays still with flags ' + flags);

      await click('.settings-cat[data-cat="sound"]');
      assert.strictEqual(await run(`document.querySelector('.settings-panel[data-cat="sound"]').hidden`), false);
      await click('.settings-cat[data-cat="system"]');
      dragResults.push(await run(`(() => {
        const bar = document.querySelector('.titlebar'); const rect = bar.getBoundingClientRect();
        const top = document.elementFromPoint(Math.round(innerWidth / 2), Math.round(rect.top + rect.height / 2));
        return { launchAtLogin: ${launchAtLogin}, alwaysShowFlowBar: ${alwaysShowFlowBar},
          target: top && (top.id || top.className), isTitlebar: !!(top && top.closest('.titlebar')),
          region: getComputedStyle(bar).getPropertyValue('-webkit-app-region') };
      })()`));
      await click('#settings-close');
      assert.strictEqual(await run(`document.getElementById('settings-overlay').hidden`), true, 'close always responds');
      assert.strictEqual(await run(`document.getElementById('notif-btn').disabled`), false, 'closing Settings re-enables the bell');
      await click('#nav-dictionary');
      assert.strictEqual(await run(`document.getElementById('view-dictionary').hidden`), false, 'navigation remains responsive');
    }
  }

  await openSystem();
  for (const [key, id] of [['launchAtLogin', 'set-launch-login'], ['alwaysShowFlowBar', 'set-always-flow'], ['showInTaskbar', 'set-taskbar']]) {
    if (key === 'alwaysShowFlowBar') await openDisplayOptions();
    else await click('.settings-cat[data-cat="system"]');
    const before = snapshot[key];
    rejectSave = true;
    await click(`#${id} + .toggle-track`);
    await waitFor(`document.getElementById('${id}').checked === ${before}`, 'rejected save restores ' + key);
    assert.strictEqual(snapshot[key], before);
    await click(`#${id} + .toggle-track`);
    assert.strictEqual(snapshot[key], !before, key + ' can be changed after a failure');
  }
  await openDisplayOptions();
  await click('#flow-bar-reset');
  assert.strictEqual(snapshot.flowBarMoved, false);
  assert.strictEqual(await run(`document.getElementById('flow-bar-position-row').hidden`), true);
  await click('.settings-cat[data-cat="system"]');
  for (const category of ['system', 'display']) {
  await click('.settings-cat[data-cat="' + category + '"]');
  for (const [width, height, zoom] of [[1120, 760, 1], [800, 650, 1], [640, 440, 1], [640, 440, 1.25]]) {
    win.setContentSize(width, height);
    win.webContents.setZoomFactor(zoom);
    await pause(220);
    const bounds = await run(`(() => {
      const r = document.querySelector('.settings-dialog').getBoundingClientRect();
      const close = document.getElementById('settings-close').getBoundingClientRect();
      const title = document.querySelector('.titlebar').getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight,
        titleBottom: title.bottom, closeReachable: document.elementFromPoint(close.x + close.width / 2, close.y + close.height / 2).id === 'settings-close' };
    })()`);
    assert.ok(bounds.left >= 0 && bounds.right <= bounds.width && bounds.top >= bounds.titleBottom && bounds.bottom <= bounds.height,
      'settings fits below the titlebar at ' + width + 'x' + height + ' zoom ' + zoom + ': ' + JSON.stringify(bounds));
    assert.ok(bounds.closeReachable, 'close remains reachable at ' + width + 'x' + height + ' zoom ' + zoom);
    if (process.argv.includes('--screenshots')) {
      await run(`document.querySelector('.settings-detail').scrollTop = 0; true`);
      await pause(100);
      const folder = path.join(__dirname, '../temp/system-settings-review');
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, category + '-' + width + '-' + height + '-' + zoom + '.png'), (await win.webContents.capturePage()).toPNG());
    }
    assert.ok(await run(`(() => { const el = document.querySelector('.settings-detail');
      el.scrollTop = el.scrollHeight; return el.scrollWidth <= el.clientWidth && (el.scrollHeight <= el.clientHeight || el.scrollTop > 0); })()`), category + ' fits horizontally and longer content stays scrollable');
  }
  }
  // Help names the keys this user really has and how their mode ends a
  // dictation, instead of the default app.html starts with.
  const helpStep = () => run(`[document.getElementById('help-step-dictate').innerHTML,
    document.getElementById('help-step-finish').textContent]`);
  assert.deepStrictEqual(await helpStep(), ['Press <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>Space</kbd> and talk',
    'Press the same keys again when you are done.'], 'help follows a toggle shortcut');
  // Each shortcut row carries its own mode radios. Clicking Both on the
  // primary row persists via shortcutUpdate and updates the radios and help.
  await run(`document.getElementById('shortcuts-change').click(); true`);
  await waitFor(`document.getElementById('shortcuts-dialog').open === true`, 'shortcuts dialog opens');
  assert.strictEqual(await run(`document.querySelectorAll('#shortcut-list .shortcut-row').length`), 1);
  assert.strictEqual(await run(`document.querySelector('#shortcut-list .shortcut-remove').disabled`), true,
    'remove stays disabled with a single shortcut');
  const primaryId = snapshot.shortcuts[0].id;
  await run(`document.querySelector('#shortcut-list .shortcut-row[data-id="${primaryId}"] .segmented-btn[data-mode="both"]').click(); true`);
  await waitFor(`document.querySelector('#shortcut-list .shortcut-row[data-id="${primaryId}"] .segmented-btn[data-mode="both"]').getAttribute('aria-checked') === 'true'`,
    'Both radio becomes checked');
  assert.strictEqual(snapshot.shortcuts[0].mode, 'both', 'Both persists via shortcutUpdate');
  assert.deepStrictEqual(saves.at(-1), { shortcutUpdate: { id: primaryId, mode: 'both' } });
  assert.deepStrictEqual(await helpStep(), ['Press or hold <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>Space</kbd> and talk',
    'Press the same keys again, or let go of a hold, when you are done.'], 'help follows a both-mode shortcut');
  // A broadcast with a push-to-talk primary still drives the hold wording.
  snapshot = { ...snapshot, shortcutLabel: 'Ctrl+Win', dictateMode: 'ptt',
    shortcuts: [{ id: primaryId, accelerator: 'CommandOrControl+Super', label: 'Ctrl+Win', mode: 'ptt' }] };
  win.webContents.send('history-updated', snapshot);
  await waitFor(`document.getElementById('help-step-dictate').textContent === 'Hold Ctrl + Win and talk'`,
    'help follows a push-to-talk shortcut');
  assert.strictEqual((await helpStep())[1], 'Let go when you are done.', 'push to talk finishes on release');
  await waitFor(`document.querySelector('#shortcut-list .shortcut-row[data-id="${primaryId}"] .segmented-btn[data-mode="ptt"]').getAttribute('aria-checked') === 'true'`,
    'broadcast ptt mode reaches the row radios');
  // Adding a second shortcut enables removal again.
  await run(`document.getElementById('shortcut-add').click(); true`);
  await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Q', ctrlKey: true, shiftKey: true, bubbles: true })); true`);
  await waitFor(`document.querySelectorAll('#shortcut-list .shortcut-row').length === 2`, 'added shortcut renders a second row');
  assert.strictEqual(snapshot.shortcuts.length, 2, 'shortcutAdd persists a second shortcut');
  assert.deepStrictEqual(saves.at(-1), { shortcutAdd: 'CommandOrControl+Shift+Q' });
  assert.strictEqual(await run(`document.querySelector('#shortcut-list .shortcut-remove').disabled`), false,
    'remove enables with two shortcuts');
  await run(`document.getElementById('shortcuts-close').click(); true`);
  await waitFor(`document.getElementById('shortcuts-dialog').open === false`, 'shortcuts dialog closes');

  assert.strictEqual(await run('systemMicRequests'), 0, 'no System control accesses the microphone');
  assert.deepStrictEqual(errors, [], 'renderer remains error-free');
  console.log('System settings: all four launch/flow combinations, clickable controls, still Island preview, navigation, save failures and compact layouts passed.');
  console.log('Settings titlebar hit tests: ' + JSON.stringify(dragResults));
  assert.ok(dragResults.every(result => result.isTitlebar && result.region === 'drag'),
    'opening Settings must keep the actual titlebar available for native window dragging');
  clearTimeout(deadline);
  win.destroy();
  app.quit();
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
