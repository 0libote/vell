'use strict';

// Native dialog provides focus containment and keyboard radio navigation.
window.VellOnboarding = (() => {
  const dialog = document.getElementById('model-welcome');
  const choices = document.getElementById('model-welcome-choices');
  const start = document.getElementById('model-welcome-start');
  const later = document.getElementById('model-welcome-later');
  const status = document.getElementById('model-welcome-status');
  const progress = document.getElementById('model-welcome-progress');
  const meter = document.getElementById('model-welcome-meter');
  const names = { voz: 'Voz' };
  let latest = {}, callbacks, deferred = false, pending = false, finished = false;
  const selected = () => { const checked = choices.querySelector('input:checked'); return checked ? checked.value : 'voz'; };

  // A model with no build for this platform is not a choice. With a single
  // engine the picker always offers Voz; the row stays so a missing build
  // could never leave Start with nothing to download.
  function offerChoices(data) {
    const offered = Array.isArray(data.availableEngines) ? data.availableEngines : null;
    if (!offered) return;
    let fallback = null;
    for (const label of choices.querySelectorAll('[data-model]')) {
      const on = offered.includes(label.dataset.model);
      label.hidden = !on;
      if (on && !fallback) fallback = label.querySelector('input');
    }
    const checked = choices.querySelector('input:checked');
    if (fallback && (!checked || checked.closest('[data-model]').hidden)) fallback.checked = true;
  }
  const bytesLabel = n => n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : Math.ceil(n / 1e6) + ' MB';

  function paint() {
    const state = latest.asrRuntimeState || {};
    const busy = pending || !!latest.asrOperation;
    choices.disabled = busy || finished;
    start.disabled = busy;
    later.disabled = state.status === 'cancelling';
    later.textContent = busy ? 'Cancel download' : finished ? 'Close' : 'Choose later';
    start.textContent = finished ? 'Start dictating' : busy ? 'Setting up…' : 'Download ' + names[selected()];
    progress.hidden = !busy;
    if (Number.isFinite(state.progress)) meter.value = Math.max(0, Math.min(100, state.progress));
    else meter.removeAttribute('value');
    status.classList.toggle('is-error', state.status === 'error');
    status.textContent = finished ? 'Voz is installed. Use ' + (latest.shortcutLabel || 'your dictation shortcut') + ' to start speaking.'
      : busy || ['error', 'cancelled'].includes(state.status) ? state.message || 'Preparing Voz…'
      : 'Vell downloads Voz once (~409 MB), then dictates offline.';
    const model = latest.asrModel;
    for (const label of choices.querySelectorAll('[data-model-size]')) {
      if (label.dataset.modelSize !== 'voz') continue;
      if (model) label.textContent = model.installed ? 'Installed' : bytesLabel(model.downloadBytes || 0);
    }
  }
  function close() {
    deferred = true;
    dialog.close();
    document.getElementById('nav-dictation')?.focus();
  }
  choices.addEventListener('change', paint);
  dialog.addEventListener('cancel', event => { event.preventDefault(); if (!pending && !latest.asrOperation) close(); });
  later.addEventListener('click', async () => {
    if (!pending && !latest.asrOperation) return close();
    later.disabled = true;
    try {
      const next = await window.vell.cancelAsrRuntime();
      if (next) callbacks.render(next);
    } catch (error) { status.textContent = error.message; }
    finally { later.disabled = false; }
  });
  start.addEventListener('click', async () => {
    if (finished) return close();
    if (pending || latest.asrOperation) return;
    pending = true;
    paint();
    try {
      const next = await window.vell.setupLocalModel(selected());
      if (next) {
        finished = next.asrRuntimeState?.status === 'installed' && next.modelPlan?.ready === true;
        callbacks.render(next);
      }
    } catch (error) {
      latest = { ...latest, asrRuntimeState: { status: 'error', message: error.message || 'Setup failed. Try again.' } };
    } finally { pending = false; paint(); }
  });
  return {
    render(data, actions) {
      latest = data;
      callbacks = actions;
      offerChoices(data);
      if (data.localModelChosen === false && !deferred && !dialog.open) dialog.showModal();
      if (dialog.open) paint();
    },
    open() { deferred = false; finished = false; dialog.showModal(); paint(); },
  };
})();
