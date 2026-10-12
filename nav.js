(() => {
  const style = document.createElement('style');
  style.textContent = 'nav a[data-signout]{margin-left:6px;padding:6px 14px;border:1px solid #ffffff80;border-radius:4px;color:#fff!important;font-weight:700;white-space:nowrap}nav a[data-signout]:hover{background:#ffffff1f}nav a[data-signout][aria-busy=true]{opacity:.6;pointer-events:none}';
  document.head.appendChild(style);

  document.addEventListener('click', async (event) => {
    const link = event.target.closest('a[data-signout]');
    if (!link) return;
    event.preventDefault();
    link.setAttribute('aria-busy', 'true');
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } finally {
      window.location.replace('/login');
    }
  });
})();
