/**
 * ui-helpers.js — Global CSP-safe UI behaviour for HCS Sync
 *
 * Patterns handled:
 *   data-confirm="message"           → shows confirm() before form submit or button click
 *   data-dismiss-target="elementId"  → removes the target element on click
 *   data-modal-open="modalId"        → removes 'hidden' class from modal on click
 *   data-modal-close="modalId"       → adds 'hidden' class to modal on click
 *   data-modal-param-*               → sets a hidden input value inside a modal on click
 *   data-submit-once                 → disables the submit button on submit
 *   data-submit-once-text            → replacement text for the button (default: "Running…")
 */
document.addEventListener('DOMContentLoaded', function () {

  // ── data-confirm ─────────────────────────────────────────────────────────
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-confirm]');
    if (!btn) return;
    var msg = btn.getAttribute('data-confirm');
    if (!confirm(msg)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);

  document.addEventListener('submit', function (e) {
    var form = e.target.closest('form[data-confirm]');
    if (!form) return;
    var msg = form.getAttribute('data-confirm');
    if (!confirm(msg)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);

  // ── data-dismiss-target ───────────────────────────────────────────────────
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-dismiss-target]');
    if (!btn) return;
    var id = btn.getAttribute('data-dismiss-target');
    var el = document.getElementById(id);
    if (el) el.remove();
  });

  // ── data-modal-open / data-modal-close ───────────────────────────────────
  // Delegates to window.openModal / window.closeModal (defined in app.js) so
  // the full modal behaviour (backdrop, flex, aria-hidden) is applied.
  // Falls back to a simple class toggle when app.js is not loaded.
  // Respects the HTML `disabled` attribute on the triggering element.
  document.addEventListener('click', function (e) {
    var opener = e.target.closest('[data-modal-open]');
    if (opener) {
      if (opener.disabled) return;
      var modalId = opener.getAttribute('data-modal-open');
      if (typeof window.openModal === 'function') {
        window.openModal(modalId);
      } else {
        var modal = document.getElementById(modalId);
        if (modal) modal.classList.remove('hidden');
      }
    }
    var closer = e.target.closest('[data-modal-close]');
    if (closer) {
      var modalId2 = closer.getAttribute('data-modal-close');
      if (typeof window.closeModal === 'function') {
        window.closeModal(modalId2);
      } else {
        var modal2 = document.getElementById(modalId2);
        if (modal2) modal2.classList.add('hidden');
      }
    }
  });

  // ── data-modal-param-* ────────────────────────────────────────────────────
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-modal-open]');
    if (!btn) return;
    var modalId = btn.getAttribute('data-modal-open');
    var modal = document.getElementById(modalId);
    if (!modal) return;
    var attrs = btn.attributes;
    for (var i = 0; i < attrs.length; i++) {
      var name = attrs[i].name;
      if (name.startsWith('data-modal-param-')) {
        var paramName = name.slice('data-modal-param-'.length);
        var input = modal.querySelector('[name="' + paramName + '"]');
        if (input) input.value = attrs[i].value;
      }
    }
  });

  // ── data-auto-submit ──────────────────────────────────────────────────────
  // Submits the closest form when the element's value changes.
  document.addEventListener('change', function (e) {
    if (!e.target.closest('[data-auto-submit]')) return;
    var form = e.target.closest('form');
    if (form) form.submit();
  });

  // ── data-submit-once ─────────────────────────────────────────────────────
  document.addEventListener('submit', function (e) {
    var form = e.target.closest('form[data-submit-once]');
    if (!form) return;
    var btn = form.querySelector('[type="submit"]');
    if (!btn) return;
    var text = btn.getAttribute('data-submit-once-text') || 'Running\u2026';
    btn.disabled = true;
    btn.textContent = text;
  });

});
