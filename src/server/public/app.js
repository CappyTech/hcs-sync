(function(){
  // ── Simple modal helpers (replaces Flowbite declarative modal API) ──
  window.openModal = function openModal(id) {
    var el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('hidden');
    el.classList.add('flex');
    el.setAttribute('aria-hidden', 'false');
    // backdrop
    var bg = document.getElementById(id + '-backdrop');
    if (!bg) {
      bg = document.createElement('div');
      bg.id = id + '-backdrop';
      bg.className = 'bg-gray-900/50 dark:bg-gray-900/80 fixed inset-0 z-40';
      bg.addEventListener('click', function () { closeModal(id); });
      document.body.appendChild(bg);
    }
    document.body.classList.add('overflow-hidden');
  };

  window.closeModal = function closeModal(id) {
    var el = document.getElementById(id);
    if (el) {
      el.classList.add('hidden');
      el.classList.remove('flex');
      el.setAttribute('aria-hidden', 'true');
    }
    var bg = document.getElementById(id + '-backdrop');
    if (bg) bg.remove();
    document.body.classList.remove('overflow-hidden');
  };

  // Close modal on Escape key
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      ['run-modal', 'dedup-modal'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el && !el.classList.contains('hidden')) closeModal(id);
      });
    }
  });

  // Theme toggle
  const btn = document.getElementById('toggle-theme');
  if (btn) {
    btn.addEventListener('click', () => {
      const root = document.documentElement;
      const dark = root.classList.toggle('dark');
      try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch {}
    });
    try {
      const saved = localStorage.getItem('theme');
      if (saved === 'dark') document.documentElement.classList.add('dark');
    } catch {}
  }

  // Live status polling
  const bars = {
    customers: { bar: document.getElementById('bar-customers'), text: document.getElementById('text-customers') },
    suppliers: { bar: document.getElementById('bar-suppliers'), text: document.getElementById('text-suppliers') },
    projects: { bar: document.getElementById('bar-projects'), text: document.getElementById('text-projects') },
    nominals: { bar: document.getElementById('bar-nominals'), text: document.getElementById('text-nominals') },
    invoices: { bar: document.getElementById('bar-invoices'), text: document.getElementById('text-invoices') },
    quotes: { bar: document.getElementById('bar-quotes'), text: document.getElementById('text-quotes') },
    purchases: { bar: document.getElementById('bar-purchases'), text: document.getElementById('text-purchases') },
  };

  function setBar(el, pct) {
    if (!el) return;
    const clamped = Math.max(0, Math.min(100, pct));
    el.style.width = clamped + '%';
    try { el.setAttribute('aria-valuenow', String(Math.round(clamped))); } catch {}
  }

  // Toasts
  const toastContainer = document.getElementById('toast-container');
  function showToast(type, message) {
    if (!toastContainer) return;
    const color = type === 'success' ? 'green' : (type === 'error' ? 'red' : 'blue');
    const wrapper = document.createElement('div');
    wrapper.className = 'flex items-center w-full max-w-xs p-4 text-gray-500 bg-white rounded-lg shadow dark:text-gray-400 dark:bg-gray-800';
    wrapper.setAttribute('role', 'status');
    wrapper.style.opacity = '0';
    wrapper.style.transition = 'opacity 150ms ease-in-out';

    const icon = document.createElement('div');
    icon.className = `inline-flex items-center justify-center flex-shrink-0 w-8 h-8 me-3 text-${color}-500 bg-${color}-100 rounded-lg dark:text-${color}-400`;
    icon.innerHTML = '<svg class="w-5 h-5" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 20 20"><path d="M10 .5a9.5 9.5 0 1 0 9.5 9.5A9.51 9.51 0 0 0 10 .5Zm1 14H9v-2h2Zm0-4H9V5h2Z"/></svg>';
    wrapper.appendChild(icon);

    const text = document.createElement('div');
    text.className = 'text-sm font-normal';
    text.textContent = message;
    wrapper.appendChild(text);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'ms-auto -mx-1.5 -my-1.5 bg-white text-gray-400 hover:text-gray-900 rounded-lg focus:ring-2 focus:ring-gray-300 p-1.5 hover:bg-gray-100 inline-flex items-center justify-center h-8 w-8 dark:text-gray-500 dark:hover:text-white dark:bg-gray-800 dark:hover:bg-gray-700';
    close.setAttribute('aria-label', 'Close');
    close.innerHTML = '<span class="sr-only">Close</span><svg class="w-3 h-3" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 14 14"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m1 1 6 6m0 0 6 6M7 7l6-6M7 7l-6 6"/></svg>';
    close.addEventListener('click', () => {
      wrapper.style.opacity = '0';
      setTimeout(() => wrapper.remove(), 150);
    });
    wrapper.appendChild(close);

    toastContainer.appendChild(wrapper);
    requestAnimationFrame(() => { wrapper.style.opacity = '1'; });
    setTimeout(() => {
      wrapper.style.opacity = '0';
      setTimeout(() => wrapper.remove(), 150);
    }, 5000);
  }

  let prevIsRunning = null;
  let prevStage = null;
  // Expose showToast for in-page buttons (history view)
  try { window.showToast = showToast; } catch {}

  function renderStatus(s) {
    if (!s || !s.items) return;
    Object.keys(bars).forEach((k) => {
      const info = bars[k];
      const item = s.items[k] || { done: 0, total: 0 };
      let pct;
      if (s.isRunning) {
        pct = item.total > 0 ? Math.round((item.done / item.total) * 100) : 0;
      } else if (s.counts && typeof s.counts[k] !== 'undefined') {
        // Finished and we have final counts → show 100%
        pct = 100;
      } else {
        // Idle and never run yet (no totals, no counts) → 0%
        pct = 0;
      }
      setBar(info.bar, pct);
      // When idle and we have final counts, show those with pct; otherwise show progress done/total with pct
      if (info.text) {
        if (!s.isRunning && s.counts && typeof s.counts[k] !== 'undefined') {
          info.text.textContent = `${String(s.counts[k])} (${pct}%)`;
        } else {
          info.text.textContent = `${item.done}/${item.total} (${pct}%)`;
        }
      }
    });
    const statusEl = document.getElementById('status-badge');
    if (statusEl) statusEl.textContent = s.isRunning ? 'Running' : (s.stage === 'failed' ? 'Failed' : 'Idle');
    const lastRunEl = document.getElementById('last-run');
    if (lastRunEl) lastRunEl.textContent = s.lastRun ? new Date(s.lastRun).toLocaleString() : 'Never';
  }

  async function poll() {
    try {
      const r = await fetch('/status', { cache: 'no-store' });
      if (r.ok) {
        const s = await r.json();
        // toasts on transitions
        if (prevIsRunning === false && s.isRunning === true) {
          showToast('info', 'Sync started');
        }
        if (prevIsRunning === true && s.isRunning === false && s.stage === 'finished') {
          showToast('success', 'Sync completed successfully');
        }
        if (s.stage === 'failed' && prevStage !== 'failed') {
          showToast('error', s.lastError || 'Sync failed');
        }
        prevIsRunning = s.isRunning;
        prevStage = s.stage;
        renderStatus(s);
      }
    } catch {}
    setTimeout(poll, 1000);
  }
  poll();
})();
