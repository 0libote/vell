'use strict';

// Checks what `npm run dist:mac` produced the way a user receives it: the zip
// is unpacked with ditto (what Finder's Archive Utility does) and the dmg is
// mounted, and each copy of the app has to pass a strict code-signature
// check, be arm64, and carry exactly the resources package.json promises.
// Prints codesign, lipo and file output for the record. macOS only; anywhere
// else it says so and exits 0.
//
//   node scripts/verify-mac-build.js [--dist dist] [--extract dist/mac-verify]
//
// The unpacked app is left at <extract>/Vell.app for smoke-mac-app.js.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

if (process.platform !== 'darwin') {
  console.log('skipped mac build verification (not macOS)');
  process.exit(0);
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const build = pkg.build;
const version = pkg.version;
const product = build.productName;
const DIST = path.resolve(ROOT, arg('dist', 'dist'));
const EXTRACT = path.resolve(ROOT, arg('extract', path.join('dist', 'mac-verify')));
const ARCH = 'arm64';

let failures = 0;
function pass(label, detail) { console.log('PASS  ' + label + (detail ? '  ' + detail : '')); }
function fail(label, detail) { failures += 1; console.log('FAIL  ' + label + (detail ? '  ' + detail : '')); }
function check(label, cond, detail) { (cond ? pass : fail)(label, detail); return !!cond; }
function section(title) { console.log('\n== ' + title); }

function run(file, args, opts) {
  const r = spawnSync(file, args, Object.assign({ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, opts || {}));
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || ''), all: String(r.stdout || '') + String(r.stderr || '') };
}

function show(title, text) {
  console.log('--- ' + title);
  for (const line of String(text).trim().split('\n')) console.log('    ' + line);
}

function mb(bytes) { return (bytes / 1e6).toFixed(1) + ' MB'; }

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(8 * 1024 * 1024);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function plist(app, key) {
  const r = run('plutil', ['-extract', key, 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist')]);
  return r.code === 0 ? r.out.trim() : null;
}

function archs(file) {
  const r = run('lipo', ['-archs', file]);
  return r.code === 0 ? r.out.trim() : 'lipo failed: ' + r.err.trim();
}

function artifactName(ext) {
  return build.mac.artifactName
    .replace('${version}', version).replace('${arch}', ARCH).replace('${ext}', ext)
    .replace('${productName}', product);
}

// Everything build.extraResources and build.mac.extraResources put into
// Contents/Resources, as the relative paths that must exist there.
function expectedResources() {
  const out = [];
  for (const entry of [].concat(build.extraResources || [], build.mac.extraResources || [])) {
    const filters = Array.isArray(entry.filter) ? entry.filter.filter((f) => !f.startsWith('!')) : [];
    if (filters.length) for (const f of filters) out.push(path.join(entry.to, f));
    else out.push(entry.to);
  }
  return out;
}

function checkApp(app, label) {
  section(label + ': signature');
  const verify = run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  show('codesign --verify --deep --strict --verbose=2', verify.all);
  check(label + ' passes codesign --verify --deep --strict', verify.code === 0);
  const display = run('codesign', ['-dvv', app]);
  show('codesign -dvv', display.all);
  check(label + ' is signed ad hoc', /Signature=adhoc/.test(display.all));
  check(label + ' runs with the hardened runtime', /flags=0x[0-9a-f]+\([^)]*runtime[^)]*\)/.test(display.all));
  check(label + ' is identified as ' + build.appId, new RegExp('Identifier=' + build.appId.replace(/\./g, '\\.') + '\\b').test(display.all));
  const ents = run('codesign', ['-d', '--entitlements', '-', '--xml', app]);
  const entText = ents.out || ents.err;
  for (const key of ['com.apple.security.cs.allow-jit', 'com.apple.security.device.audio-input', 'com.apple.security.cs.disable-library-validation']) {
    check(label + ' carries ' + key, entText.includes(key));
  }

  section(label + ': Info.plist');
  const keys = {
    CFBundleIdentifier: plist(app, 'CFBundleIdentifier'),
    CFBundleExecutable: plist(app, 'CFBundleExecutable'),
    CFBundleShortVersionString: plist(app, 'CFBundleShortVersionString'),
    CFBundleVersion: plist(app, 'CFBundleVersion'),
    LSMinimumSystemVersion: plist(app, 'LSMinimumSystemVersion'),
    NSMicrophoneUsageDescription: plist(app, 'NSMicrophoneUsageDescription'),
    LSApplicationCategoryType: plist(app, 'LSApplicationCategoryType'),
  };
  for (const [k, v] of Object.entries(keys)) console.log('    ' + k + ' = ' + v);
  check('bundle id is ' + build.appId, keys.CFBundleIdentifier === build.appId);
  check('version is ' + version, keys.CFBundleShortVersionString === version);
  check('microphone usage text is the one in package.json',
    keys.NSMicrophoneUsageDescription === build.mac.extendInfo.NSMicrophoneUsageDescription);
  check('a minimum macOS version is declared', !!keys.LSMinimumSystemVersion, keys.LSMinimumSystemVersion || '');

  section(label + ': executables');
  const exe = path.join(app, 'Contents', 'MacOS', keys.CFBundleExecutable || product);
  const res = path.join(app, 'Contents', 'Resources');
  const binaries = [
    ['main executable', exe],
    ['platform helper', path.join(res, 'helper', 'voxden-helper')],
  ];
  for (const [name, file] of binaries) {
    if (!check(name + ' exists', fs.existsSync(file), path.relative(app, file))) continue;
    const mode = fs.statSync(file).mode;
    check(name + ' is executable', (mode & 0o111) !== 0, (mode & 0o777).toString(8));
    const a = archs(file);
    check(name + ' is ' + ARCH, a.split(/\s+/).includes(ARCH), a);
    console.log('    file: ' + run('file', ['-b', file]).out.trim());
    const v = run('codesign', ['--verify', '--strict', '--verbose=2', file]);
    check(name + ' has a valid signature of its own', v.code === 0, v.all.trim().split('\n').pop());
  }

  section(label + ': resources');
  for (const rel of expectedResources()) {
    const p = path.join(res, rel);
    const exists = fs.existsSync(p);
    const size = exists && fs.statSync(p).isFile() ? mb(fs.statSync(p).size) : exists ? 'dir' : '';
    check('Resources/' + rel, exists, size);
  }
  for (const rel of ['app.asar', 'app-update.yml', 'icon.icns']) {
    check('Resources/' + rel, fs.existsSync(path.join(res, rel)));
  }
  check('no Python sidecar ships anymore', !fs.existsSync(path.join(res, 'sidecar')));
  for (const rel of [path.join('scripts', 'win32.ps1'), path.join('scripts', 'correction-watch.ps1'), path.join('pack-tools', '7za.exe')]) {
    check('no Windows-only Resources/' + rel, !fs.existsSync(path.join(res, rel)));
  }
  const updateYml = path.join(res, 'app-update.yml');
  if (fs.existsSync(updateYml)) show('app-update.yml', fs.readFileSync(updateYml, 'utf8'));
  return { exe, res };
}

function checkRuntime(res) {
  section('bundled Voz runtime (onnxruntime-node unpacked beside the asar)');
  const binding = path.join(res, 'app.asar.unpacked', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6', 'darwin', 'arm64', 'onnxruntime_binding.node');
  if (!check('unpacked onnxruntime binding present', fs.existsSync(binding), binding)) return;
  const a = archs(binding);
  check('binding is ' + ARCH, a.split(/\s+/).includes(ARCH), a);
  return { dir: res };
}

function checkVozProvider(res) {
  section('Voz provider in the bundle (loads without downloading a model)');
  const unpacked = path.join(res, 'app.asar.unpacked', 'node_modules');
  const ortPkgPath = path.join(unpacked, 'onnxruntime-node', 'package.json');
  if (!check('unpacked onnxruntime-node present', fs.existsSync(ortPkgPath), ortPkgPath)) return;
  try {
    const ortPkg = JSON.parse(fs.readFileSync(ortPkgPath, 'utf8'));
    check('unpacked onnxruntime matches the repo dependency',
      ortPkg.version === require('../package.json').dependencies['onnxruntime-node'].replace(/^[^\d]*/, ''),
      ortPkg.version);
  } catch (e) {
    check('unpacked onnxruntime package.json parses', false, String(e && e.message || e));
  }
}

// Voz ships no Python runtime and no sidecar: the "install" is the provider
// fetching its own ~409MB bundle on first setup. What the bundle must prove
// is narrower: onnxruntime-node is unpacked beside the asar (native bindings
// cannot load from inside an asar), the binding is arm64, and the Voz SDK +
// model manager resolve from the packaged app.
async function installRuntime(res, bundled) {
  section('Voz bundle install path (no Python, no sidecar)');
  check('no bundled speech-runtime dir ships anymore',
    !require('fs').existsSync(require('path').join(res, 'speech-runtime')));
  const { VozModelManager } = require('../src/voz-model');
  let manager = null;
  try {
    manager = new VozModelManager({ dataDir: require('path').join(EXTRACT, 'voz-data') });
    pass('voz-model manager loads from the repo (same code as the bundle)');
  } catch (err) {
    fail('voz-model manager loads from the repo (same code as the bundle)', String(err && err.message || err));
    return;
  }
  const snap = manager.snapshot();
  check('Voz snapshot reports not-installed before first download',
    snap && snap.id === 'voz' && snap.installed === false, JSON.stringify(snap));
  check('Voz advertises its ~409MB download size',
    Number(snap.downloadBytes) > 300e6 && Number(snap.downloadBytes) < 600e6, String(snap.downloadBytes));
  const binding = require('path').join(res, 'app.asar.unpacked', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6', 'darwin', 'arm64', 'onnxruntime_binding.node');
  if (check('unpacked onnxruntime binding present (install-time load path)', require('fs').existsSync(binding), binding)) {
    const v = run('codesign', ['--verify', '--strict', binding]);
    check('onnxruntime binding has a valid signature', v.code === 0, v.all.trim().split('\n').pop());
  }
}

async function main() {
  section('artifacts in ' + path.relative(ROOT, DIST));
  const zipName = artifactName('zip');
  const dmgName = artifactName('dmg');
  const zip = path.join(DIST, zipName);
  const dmg = path.join(DIST, dmgName);
  const feed = path.join(DIST, 'latest-mac.yml');
  for (const file of [zip, dmg, feed]) {
    check(path.basename(file), fs.existsSync(file), fs.existsSync(file) ? mb(fs.statSync(file).size) : 'missing');
  }
  if (fs.existsSync(feed)) {
    const text = fs.readFileSync(feed, 'utf8');
    show('latest-mac.yml', text);
    check('latest-mac.yml names ' + version, new RegExp('^version: ' + version.replace(/\./g, '\\.') + '$', 'm').test(text));
    check('latest-mac.yml lists the zip', text.includes(zipName));
  }
  if (!fs.existsSync(zip)) return;

  section('unpacking the zip with ditto');
  fs.rmSync(EXTRACT, { recursive: true, force: true });
  fs.mkdirSync(EXTRACT, { recursive: true });
  const ditto = run('ditto', ['-x', '-k', zip, EXTRACT]);
  check('ditto unpacks the zip', ditto.code === 0, ditto.err.trim());
  const zipApp = path.join(EXTRACT, product + '.app');
  check('the zip holds ' + product + '.app at its root', fs.existsSync(zipApp),
    fs.readdirSync(EXTRACT).join(', '));
  if (fs.existsSync(zipApp)) {
    const { res } = checkApp(zipApp, 'zip app');
    const bundled = checkRuntime(res);
    if (bundled) await installRuntime(res, bundled);
    const afterProbe = run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', zipApp]);
    check('zip app signature remains valid after speech probes', afterProbe.code === 0, afterProbe.all.trim());
    section('Gatekeeper (informational: an ad-hoc app is expected to be rejected until notarized)');
    show('spctl --assess --type execute -vv', run('spctl', ['--assess', '--type', 'execute', '-vv', zipApp]).all);
  }

  if (fs.existsSync(dmg)) {
    section('mounting the dmg');
    const mount = path.join(EXTRACT, 'dmg-mount');
    fs.mkdirSync(mount, { recursive: true });
    const attach = run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, dmg]);
    if (check('hdiutil attaches the dmg', attach.code === 0, attach.err.trim())) {
      try {
        const entries = fs.readdirSync(mount);
        console.log('    dmg root: ' + entries.join(', '));
        check('the dmg holds ' + product + '.app', entries.includes(product + '.app'));
        const apps = path.join(mount, 'Applications');
        check('the dmg links to /Applications', fs.existsSync(apps) && fs.lstatSync(apps).isSymbolicLink()
          && fs.readlinkSync(apps) === '/Applications');
        const dmgApp = path.join(mount, product + '.app');
        if (fs.existsSync(dmgApp)) {
          const verify = run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', dmgApp]);
          check('dmg app passes codesign --verify --deep --strict', verify.code === 0, verify.all.trim().split('\n').pop());
          check('dmg app is version ' + version, plist(dmgApp, 'CFBundleShortVersionString') === version);
          const exe = path.join(dmgApp, 'Contents', 'MacOS', plist(dmgApp, 'CFBundleExecutable') || product);
          check('dmg app executable is ' + ARCH, archs(exe).split(/\s+/).includes(ARCH));
        }
      } finally {
        const detach = run('hdiutil', ['detach', mount]);
        if (detach.code !== 0) run('hdiutil', ['detach', '-force', mount]);
      }
    }
  }
}

main().catch((err) => fail('verification crashed', err && err.stack || String(err))).finally(() => {
  console.log('\n' + (failures ? failures + ' check(s) failed' : 'every mac build check passed'));
  process.exit(failures ? 1 : 0);
});
