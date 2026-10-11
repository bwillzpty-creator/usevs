const form = document.getElementById('profileForm');
const statusEl = document.getElementById('status');
const saveButton = document.getElementById('saveProfile');
const fields = ['legalName', 'businessAddress', 'taxId', 'businessPhone', 'businessEmail', 'signatoryName', 'signatoryTitle', 'signatoryEmail'];

function setStatus(message, kind) {
  statusEl.textContent = message;
  statusEl.className = kind || '';
}

async function api(url, options) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  const result = await response.json().catch(() => ({}));
  if (response.status === 401) {
    window.location.href = result.redirectUrl || '/login';
    return null;
  }
  if (!response.ok || !result.success) throw new Error(result.message || 'Request failed.');
  return result;
}

function fill(profile) {
  fields.forEach((name) => { document.getElementById(name).value = profile[name] || ''; });
  document.getElementById('signedInAs').textContent = profile.signatoryEmail || '';
}

async function load() {
  try {
    const result = await api('/api/account/profile');
    if (result) fill(result.profile);
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  const body = {};
  fields.filter((name) => name !== 'signatoryEmail').forEach((name) => { body[name] = document.getElementById(name).value; });
  saveButton.disabled = true;
  setStatus('Saving...');
  try {
    const result = await api('/api/account/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (result) {
      fill(result.profile);
      setStatus('Profile saved.', 'good');
    }
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    saveButton.disabled = false;
  }
});

document.getElementById('signOut').addEventListener('click', async () => {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } finally {
    window.location.href = '/login';
  }
});

load();
