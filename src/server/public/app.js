(function(){
  const btn = document.getElementById('toggle-theme');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const root = document.documentElement;
    const dark = root.classList.toggle('dark');
    try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch {}
  });
  try {
    const saved = localStorage.getItem('theme');
    if (saved === 'dark') document.documentElement.classList.add('dark');
  } catch {}
})();
