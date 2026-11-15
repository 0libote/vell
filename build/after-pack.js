'use strict';

// electron-builder copies extraResources with their source permissions; the
// mac helper binary needs the execute bit, so it is set here once per build.
//
// The bundle is then signed ad hoc. electron-builder 25 only signs with a real
// identity: with CSC_IDENTITY_AUTO_DISCOVERY=false and none configured it logs
// "skipped macOS application code signing" and leaves the signature Electron
// shipped with, which the rebranding (renamed executable, rewritten
// Info.plist, added resources) has already broken. Apple Silicon will not run
// arm64 code whose signature does not verify, and Gatekeeper calls a download
// in that state "damaged" with no way past it. An ad-hoc signature is valid,
// just not tied to a developer, so the app gets the ordinary unidentified
// developer path instead (Privacy & Security > Open Anyway). This runs in
// afterPack because the zip and dmg targets are built from this bundle after
// the hook returns. A real identity (CSC_LINK or CSC_NAME) skips it and lets
// electron-builder sign.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ENTITLEMENTS = path.join(__dirname, 'entitlements.mac.plist');

function codesign(args) {
  execFileSync('codesign', args, { stdio: 'inherit' });
}

function signAdHoc(appPath, binaries, log = console.log) {
  // Mach-O files under Resources are not code locations --deep walks, so each
  // gets its own signature first; the bundle seal then covers them as files.
  for (const file of binaries) codesign(['--force', '--sign', '-', '--timestamp=none', file]);
  codesign([
    '--force', '--deep', '--sign', '-', '--timestamp=none',
    '--options', 'runtime',
    '--entitlements', ENTITLEMENTS,
    appPath,
  ]);
  codesign(['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  log('after-pack: signed ad hoc and verified ' + appPath);
}

// onnxruntime-node ships native bindings for every platform inside the npm
// package, and asarUnpack copies all of them beside the asar. Only the
// platform being packed can ever load, so the rest is deleted here: ~70MB
// of linux/win32 bindings on a Mac build, and the reverse on Windows.
//
// context.arch is electron-builder's numeric Arch enum, not a name, so it is
// translated back first; anything unrecognised disables arch pruning rather
// than deleting the binding the app needs.
function pruneForeignBindings(resources, platformName, arch) {
  const { Arch } = require('builder-util');
  const archName = typeof arch === 'string' ? arch : Arch[arch];
  const bin = path.join(resources, 'app.asar.unpacked', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6');
  if (!fs.existsSync(bin)) return;
  for (const entry of fs.readdirSync(bin, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(bin, entry.name);
    if (entry.name !== platformName) {
      fs.rmSync(full, { recursive: true, force: true });
      continue;
    }
    if (typeof archName !== 'string') continue;
    for (const sub of fs.readdirSync(full, { withFileTypes: true })) {
      if (sub.isDirectory() && sub.name !== archName) fs.rmSync(path.join(full, sub.name), { recursive: true, force: true });
    }
  }
}

module.exports = async function afterPack(context) {
  const app = context.packager.appInfo.productFilename + '.app';
  const appPath = path.join(context.appOutDir, app);
  const resources = path.join(appPath, 'Contents', 'Resources');
  pruneForeignBindings(resources, context.electronPlatformName, context.arch);
  if (context.electronPlatformName !== 'darwin') return;
  const binaries = [path.join(resources, 'helper', 'vell-helper')];
  for (const file of binaries) {
    if (!fs.existsSync(file)) throw new Error('after-pack: ' + file + ' is missing');
    fs.chmodSync(file, 0o755);
  }
  if (process.env.CSC_LINK || process.env.CSC_NAME) {
    console.log('after-pack: a signing identity is configured, leaving the signature to electron-builder');
    return;
  }
  if (process.platform !== 'darwin') throw new Error('after-pack: an ad-hoc signature needs codesign, which only exists on macOS');
  signAdHoc(appPath, binaries);
};

module.exports.signAdHoc = signAdHoc;
module.exports.ENTITLEMENTS = ENTITLEMENTS;
