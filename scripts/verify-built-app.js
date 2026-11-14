'use strict';

// Strictly identify a newly built installer and the code/resources beside it.
// Unlike smoke checks, a stale package must fail this comparison.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2] || path.join(root, 'dist'));
const resources = path.join(output, 'win-unpacked', 'resources');
const archive = path.join(resources, 'app.asar');
const pkg = require('../package.json');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sha256File = (file) => digest(fs.readFileSync(file));
function files(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === '__pycache__' || entry.name.endsWith('.pyc')) return [];
    const name = path.join(dir, entry.name);
    return entry.isDirectory() ? files(name) : [name];
  });
}
async function main() {
  const built = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  assert.strictEqual(built.version, pkg.version, 'built version differs from source');
  let sourceFiles = 0;
  for (const file of files(path.join(root, 'src'))) {
    const relative = path.relative(root, file).replace(/\\/g, '/');
    assert.strictEqual(digest(asar.extractFile(archive, relative)), digest(fs.readFileSync(file)), relative + ' is stale in app.asar');
    sourceFiles++;
  }
  // No Python sidecar ships anymore: Voz runs in-process via onnxruntime-node.
  assert.ok(!fs.existsSync(path.join(resources, 'sidecar')), 'stale sidecar ships in resources');
  assert.ok(!fs.existsSync(path.join(resources, 'speech-runtime')), 'stale speech-runtime ships in resources');
  assert.ok(!fs.existsSync(path.join(resources, 'pack-tools', '7za.exe')), 'stale 7za ships in resources');
  for (const relative of ['scripts/win32.ps1', 'scripts/correction-watch.ps1', 'scripts/vocabulary-seed.json']) {
    assert.strictEqual(sha256File(path.join(resources, relative)), sha256File(path.join(root, relative)), relative + ' is stale in resources');
  }
  // onnxruntime-node ships unpacked beside the asar (native bindings cannot
  // load from inside an asar).
  const binding = path.join(resources, 'app.asar.unpacked', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6', 'win32', 'x64', 'onnxruntime_binding.node');
  assert.ok(fs.existsSync(binding), 'unpacked onnxruntime binding missing: ' + binding);
  // The Voz SDK ships inside the asar.
  const vozPkg = JSON.parse(asar.extractFile(archive, 'node_modules/@desert-ant-labs/voz/package.json').toString('utf8'));
  assert.strictEqual(vozPkg.name, '@desert-ant-labs/voz');
  const highlights = require('../src/announcements').CATALOG.filter(row => row.since === pkg.version);
  const installer = path.join(output, 'Vell-Setup-' + pkg.version + '.exe');
  const report = {
    version: built.version, sourceFiles, sidecarFiles: 0,
    releaseHighlights: highlights.map(row => ({ id: row.id, title: row.title })),
    engine: 'voz', installer, installerBytes: fs.statSync(installer).size,
    installerSha256: sha256File(installer), appAsarSha256: sha256File(archive),
  };
  fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
