'use strict';

// Desert Ant Voz model management: the single speech model Vell ships.
//
// Unlike the old per-engine packs, Voz is not a zip Vell downloads and
// verifies itself. The official SDK fetches its own ~409MB bundle on first
// use and caches it under the OS cache root
// (<cache>/desert-ant-models/...), so install() is Voz.load() with progress
// and remove() deletes that cache tree. A receipt in Vell's own data dir
// records what install() put there, so uninstalls and clean-remove stay
// exact and a half-download is never mistaken for a model.

const fs = require('fs');
const os = require('os');
const path = require('path');

// What the picker and the banner quote before anything is on disk. Measured
// 409MB for the v0.5.0 web bundle (see docs/VOZ-SPIKE.md); the receipt carries
// the real byte count once install() has run.
const BUNDLE_BYTES = 409000000;

function cacheRoot() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches');
  if (process.env.XDG_CACHE_HOME) return process.env.XDG_CACHE_HOME;
  return path.join(os.homedir(), '.cache');
}

function bundleRoot() {
  return path.join(cacheRoot(), 'desert-ant-models');
}

function dirSize(dir) {
  let total = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return 0;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += dirSize(p);
      else if (entry.isFile()) total += fs.statSync(p).size;
    } catch (_) { /* a file vanishing mid-scan is not an install */ }
  }
  return total;
}

function bundlePresent() {
  try {
    return fs.readdirSync(bundleRoot()).length > 0 && dirSize(bundleRoot()) > 0;
  } catch (_) {
    return false;
  }
}

class VozModelManager {
  constructor(options) {
    const opts = options || {};
    this.dataDir = opts.dataDir || null;
    this.onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    this._receipt = null;
  }

  receiptPath() {
    if (!this.dataDir) return null;
    return path.join(this.dataDir, 'voz-receipt.json');
  }

  readReceipt() {
    if (this._receipt) return this._receipt;
    const file = this.receiptPath();
    if (!file) return null;
    try {
      this._receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
      this._receipt = null;
    }
    return this._receipt;
  }

  writeReceipt(receipt) {
    const file = this.receiptPath();
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(receipt, null, 2));
    this._receipt = receipt;
  }

  installed() {
    return bundlePresent();
  }

  installedBytes() {
    if (!this.installed()) return 0;
    const receipt = this.readReceipt();
    if (receipt && Number.isFinite(receipt.bytes) && receipt.bytes > 0) return receipt.bytes;
    return dirSize(bundleRoot());
  }

  snapshot() {
    const installed = this.installed();
    return {
      id: 'voz',
      name: 'Voz',
      installed,
      downloadBytes: installed ? 0 : BUNDLE_BYTES,
      installedBytes: installed ? this.installedBytes() : 0,
    };
  }

  directory() {
    return bundleRoot();
  }

  report(state) {
    if (this.onProgress) {
      try {
        this.onProgress(state);
      } catch (_) { /* progress must never break an install */ }
    }
  }

  // Download (if needed), compile and warm the model. The shared provider
  // loader means a later transcription reuses this exact instance instead of
  // loading 1.2GB twice.
  async install(options) {
    const opts = options || {};
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const { ensureVoz } = require('./transcription-provider');
    this.report({ status: 'downloading', progress: 0 });
    await ensureVoz({
      onProgress: (fraction) => {
        const progress = Math.max(0, Math.min(100, Math.round(Number(fraction || 0) * 100)));
        this.report({ status: 'downloading', progress });
        if (onProgress) onProgress(fraction);
      },
    });
    const bytes = dirSize(bundleRoot());
    this.writeReceipt({ id: 'voz', bytes, installedAt: Date.now() });
    this.report({ status: 'installed', progress: 100 });
    return this.snapshot();
  }

  async remove() {
    const { dropVoz } = require('./transcription-provider');
    try {
      await dropVoz();
    } catch (_) { /* a model that never loaded has nothing to drop */ }
    fs.rmSync(bundleRoot(), { recursive: true, force: true });
    const file = this.receiptPath();
    if (file) fs.rmSync(file, { force: true });
    this._receipt = null;
    this.report({ status: 'removed', progress: 100 });
    return this.snapshot();
  }
}

module.exports = {
  VozModelManager,
  VOZ_BUNDLE_BYTES: BUNDLE_BYTES,
  vozCacheRoot: bundleRoot,
};
