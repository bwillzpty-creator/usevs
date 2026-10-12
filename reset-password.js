(() => {
  const form = document.getElementById('resetForm');
  const status = document.getElementById('status');
  const invalidNotice = document.getElementById('invalidNotice');
  const invalidAction = document.getElementById('invalidAction');
  const done = document.getElementById('done');
  const token = new URLSearchParams(window.location.search).get('token') || '';

  // Keep the token out of history and referrers once it has been read.
  if (token) window.history.replaceState(null, '', '/reset-password');

  function showInvalid(message) {
    form.hidden = true;
    if (message) invalidNotice.textContent = message;
    invalidNotice.hidden = false;
    invalidAction.hidden = false;
  }

  async function validate() {
    if (!token) return showInvalid();
    try {
      const response = await fetch(`/api/auth/reset-password/validate?token=${encodeURIComponent(token)}`, { credentials: 'same-origin' });
      const result = await response.json();
      if (!result.valid) return showInvalid();
      form.hidden = false;
      form.elements.newPassword.focus();
    } catch {
      showInvalid('We could not check this link. Please try again.');
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    status.classList.remove('error');
    const { newPassword, confirmPassword } = form.elements;
    if (newPassword.value !== confirmPassword.value) {
      status.textContent = 'New password and confirmation do not match.';
      status.classList.add('error');
      return;
    }
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    status.textContent = 'Saving…';
    try {
      const response = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ token, newPassword: newPassword.value, confirmPassword: confirmPassword.value })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (/invalid or has expired/.test(result.message || '')) return showInvalid(result.message);
        throw new Error(result.message || 'The password could not be reset.');
      }
      form.reset();
      form.hidden = true;
      done.hidden = false;
      setTimeout(() => { window.location.href = '/login'; }, 3000);
    } catch (error) {
      status.textContent = error.message;
      status.classList.add('error');
      button.disabled = false;
    }
  });

  validate();
})();
