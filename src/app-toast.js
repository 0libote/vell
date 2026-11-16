/* The island capsule that confirms a quick action, such as a copy, at the
   bottom of the window and then gets out of the way. Duration is per-call:
   short confirmations use the default, longer suggestion notices pass more. */
(function initAppToast(root) {
  'use strict';
  const DEFAULT_MS = 1900;
  const LEAVE_MS = 220;
  let hideTimer = 0;
  let removeTimer = 0;

  function showAppToast(message, durationMs) {
    const el = root.document.getElementById('app-toast');
    if (!el) return;
    el.querySelector('.app-toast-text').textContent = String(message || '');
    const showMs = Number.isFinite(durationMs) ? Math.max(1200, Math.min(6000, durationMs)) : DEFAULT_MS;
    clearTimeout(hideTimer);
    clearTimeout(removeTimer);
    el.hidden = false;
    el.classList.remove('is-shown', 'is-leaving');
    // A second toast while one shows plays the entrance again.
    void el.offsetWidth;
    el.classList.add('is-shown');
    hideTimer = setTimeout(() => {
      el.classList.add('is-leaving');
      removeTimer = setTimeout(() => {
        el.hidden = true;
        el.classList.remove('is-shown', 'is-leaving');
      }, LEAVE_MS);
    }, showMs);
  }

  root.showAppToast = showAppToast;
})(window);
