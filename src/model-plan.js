'use strict';

// What this machine actually needs to download, and what is merely on offer.
//
// Vell ships one engine, Desert Ant Voz, whose ~409MB bundle the provider
// fetches itself on install and caches afterwards. There are no packs to
// choose between and no per-engine downloads to add up.
//
// This module is the single answer to "what does this configuration need".
// It is pure: it takes the settings, the sizes and what is already on disk,
// and returns a plan. Nothing here downloads anything.

const capabilities = require('./asr-capabilities');

// Which engines are on offer, per platform. Vell ships one: Desert Ant Voz,
// on every platform it ships on.
const PLATFORM_ENGINES = Object.freeze({
  win32: capabilities.ENGINE_IDS,
  darwin: capabilities.ENGINE_IDS,
});

// Anything that is not a platform this app ships on gets the full list rather
// than an empty picker: the only such build is a developer's, and hiding
// engines from it would hide bugs with them.
function availableEngines(platform) {
  const os = String(platform === undefined ? process.platform : platform);
  return (PLATFORM_ENGINES[os] || PLATFORM_ENGINES.win32).slice();
}

function engineOffered(engine, platform) {
  return availableEngines(platform).includes(String(engine || '').trim().toLowerCase());
}

const ENGINE_MODELS = Object.freeze({
  // The provider fetches and caches its own ~409MB bundle on install (see
  // src/voz-model.js); there is no dist pack for it.
  voz: 'voz',
});

const COMPONENTS = Object.freeze({
  voz: Object.freeze({
    id: 'voz',
    name: 'Voz',
    manager: 'provider',
    summary: 'Desert Ant on-device speech model. Downloads once (~409 MB), then runs offline.',
  }),
});

const COMPONENT_IDS = Object.freeze(Object.keys(COMPONENTS));

function modelForEngine(engine) {
  const id = String(engine || 'voz').trim().toLowerCase();
  return ENGINE_MODELS[id] || 'voz';
}

// Single engine, single pack: nothing to choose between.
function parakeetPackFor() {
  return 'voz';
}

// No faster path to offer: Voz is the whole pipeline.
function fastPathOffered() {
  return false;
}

// No GPU weights to show: Voz runs on the CPU through onnxruntime-node.
function gpuWeightsOffered() {
  return false;
}

function bytesFor(id, sizes) {
  const value = Number((sizes || {})[id]);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

// The plan for one configuration.
//
//   required  what the current engine cannot run without
//   optional  what is on offer, and why
//   missing   required components that are not on disk yet
//
// `installed` is a map of id -> boolean. `sizes` is id -> download bytes,
// taken from the managers rather than hardcoded here, so the catalog stays the
// one place the numbers live.
function plan(options) {
  const opts = options || {};
  const engine = String(opts.engine || 'voz').trim().toLowerCase();
  const device = 'cpu';
  const installed = opts.installed || {};
  const sizes = opts.sizes || {};
  const required = modelForEngine(engine, device);

  const items = [];
  for (const id of COMPONENT_IDS) {
    const component = COMPONENTS[id];
    const isInstalled = !!installed[id];
    let role = 'hidden';
    let reason = '';

    if (id === required) {
      role = 'required';
      reason = 'The engine you chose needs it.';
    }

    items.push({
      id,
      name: component.name,
      summary: component.summary,
      manager: component.manager,
      bytes: bytesFor(id, sizes),
      installed: isInstalled,
      role,
      reason,
    });
  }

  const pick = (role) => items.filter((i) => i.role === role).map((i) => i.id);
  const missing = items.filter((i) => i.role === 'required' && !i.installed).map((i) => i.id);
  const sum = (list) => list.reduce((n, i) => n + i.bytes, 0);

  return {
    engine,
    device,
    required: pick('required'),
    optional: pick('optional'),
    hidden: pick('hidden'),
    missing,
    items,
    // What a first run has to fetch before dictation works.
    requiredBytes: sum(items.filter((i) => i.role === 'required' && !i.installed)),
    optionalBytes: sum(items.filter((i) => i.role === 'optional' && !i.installed)),
    ready: missing.length === 0,
  };
}

// Everything that would have to be downloaded for a configuration to work,
// used when the user changes engine or processor. Returns [] when the switch
// costs nothing, which is what lets the UI switch silently in the common case
// and offer a download only when there is one.
function missingFor(options) {
  return plan(options).missing;
}

module.exports = {
  COMPONENTS,
  COMPONENT_IDS,
  PLATFORM_ENGINES,
  availableEngines,
  engineOffered,
  parakeetPackFor,
  modelForEngine,
  fastPathOffered,
  gpuWeightsOffered,
  plan,
  missingFor,
};
