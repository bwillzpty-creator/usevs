let loginChallengeId = '';

async function requestJson(url, options) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || 'The request could not be completed.');
  return result;
}

function showMessage(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle('error', isError);
}

function readBusinessDocument(file) {
  if (!file) return Promise.resolve('');
  if (file.size > 5 * 1024 * 1024) return Promise.reject(new Error('Business document must be smaller than 5 MB.'));
  if (!['application/pdf', 'image/png', 'image/jpeg'].includes(file.type)) {
    return Promise.reject(new Error('Upload a PDF, PNG, or JPEG business document.'));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(reader.result));
    reader.addEventListener('error', () => reject(new Error('Unable to read the selected document.')));
    reader.readAsDataURL(file);
  });
}

const loginForm = document.getElementById('loginForm');
const otpForm = document.getElementById('otpForm');
const loginStatus = document.getElementById('loginStatus');
const otpStatus = document.getElementById('otpStatus');

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = loginForm.querySelector('button[type="submit"]');
  button.disabled = true;
  showMessage(loginStatus, 'Checking employer and signatory authorization...');
  try {
    const result = await requestJson('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: loginForm.elements.email.value,
        password: loginForm.elements.password.value
      })
    });
    loginChallengeId = result.challengeId;
    otpForm.hidden = false;
    showMessage(loginStatus, result.message);
    document.getElementById('loginCode').focus();
  } catch (error) {
    showMessage(loginStatus, error.message, true);
  } finally {
    button.disabled = false;
  }
});

otpForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = otpForm.querySelector('button[type="submit"]');
  button.disabled = true;
  showMessage(otpStatus, 'Verifying signatory code...');
  try {
    await requestJson('/api/auth/otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId: loginChallengeId, code: otpForm.elements.code.value })
    });
    window.location.assign('/');
  } catch (error) {
    showMessage(otpStatus, error.message, true);
    otpForm.elements.code.value = '';
    otpForm.elements.code.focus();
  } finally {
    button.disabled = false;
  }
});

document.getElementById('employerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const status = document.getElementById('registrationStatus');
  button.disabled = true;
  showMessage(status, 'Creating the pending employer account...');
  try {
    const businessDocument = await readBusinessDocument(form.elements.businessDocument.files[0]);
    const result = await requestJson('/api/employers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        legalBusinessName: form.elements.legalBusinessName.value,
        businessAddress: form.elements.businessAddress.value,
        businessPhone: form.elements.businessPhone.value,
        businessEmail: form.elements.businessEmail.value,
        officerName: form.elements.officerName.value,
        officerTitle: form.elements.officerTitle.value,
        officerEmail: form.elements.officerEmail.value,
        officerPassword: form.elements.officerPassword.value,
        businessDocument
      })
    });
    form.reset();
    showMessage(status, result.message);
  } catch (error) {
    showMessage(status, error.message, true);
  } finally {
    button.disabled = false;
  }
});

requestJson('/api/auth/session').then(() => {
  window.location.replace('/');
}).catch(() => {});
