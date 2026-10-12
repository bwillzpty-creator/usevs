(() => {
  async function postJson(url, body) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.message || 'The request could not be completed.');
    return result;
  }

  const loginForm = document.getElementById('loginForm');
  if (loginForm) {
    const otpForm = document.getElementById('otpForm');
    const loginStatus = document.getElementById('loginStatus');
    const otpStatus = document.getElementById('otpStatus');
    const otpAlert = document.getElementById('otpAlert');
    const heading = document.getElementById('loginHeading');
    const registerHint = document.getElementById('registerHint');
    const codeInput = document.getElementById('loginCode');
    let challengeId = '';
    let pendingCredentials = null;

    function showStep(step) {
      const second = step === 2;
      loginForm.hidden = second;
      otpForm.hidden = !second;
      registerHint.hidden = second;
      heading.textContent = second ? 'Verify your email' : 'Sign in';
      if (second) {
        otpForm.classList.add('first-step-hidden');
        codeInput.value = '';
        codeInput.focus({ preventScroll: true });
      } else {
        pendingCredentials = null;
        challengeId = '';
        loginForm.elements.password.value = '';
        loginForm.elements.email.focus();
      }
    }

    async function requestCode(credentials) {
      const result = await postJson('/api/auth/login', credentials);
      challengeId = result.challengeId;
      pendingCredentials = credentials;
      otpAlert.textContent = `A six-digit verification code was sent to ${credentials.email}.`;
      otpStatus.textContent = '';
      otpStatus.classList.remove('error');
      loginStatus.textContent = '';
      showStep(2);
    }

    loginForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = loginForm.querySelector('button[type="submit"]');
      button.disabled = true;
      loginStatus.textContent = 'Verifying sign-in details…';
      loginStatus.classList.remove('error');
      try {
        await requestCode({
          email: loginForm.elements.email.value.trim(),
          password: loginForm.elements.password.value
        });
      } catch (error) {
        loginStatus.textContent = error.message;
        loginStatus.classList.add('error');
      } finally {
        button.disabled = false;
      }
    });

    document.getElementById('backToLogin').addEventListener('click', () => {
      otpStatus.textContent = '';
      showStep(1);
    });

    const resetRequestForm = document.getElementById('resetRequestForm');
    const resetForm = document.getElementById('resetForm');
    const loginNotice = document.getElementById('loginNotice');
    let resetEmail = '';

    function showView(view) {
      loginForm.hidden = view !== 'login';
      otpForm.hidden = true;
      resetRequestForm.hidden = view !== 'resetRequest';
      resetForm.hidden = view !== 'reset';
      registerHint.hidden = view !== 'login';
      heading.textContent = view === 'login' ? 'Sign in' : 'Reset password';
      if (view !== 'login') loginNotice.hidden = true;
      const focusTarget = { login: loginForm.elements.email, resetRequest: resetRequestForm.elements.email, reset: resetForm.elements.code }[view];
      focusTarget.focus({ preventScroll: true });
    }

    document.getElementById('forgotLink').addEventListener('click', (event) => {
      event.preventDefault();
      resetRequestForm.elements.email.value = loginForm.elements.email.value;
      showView('resetRequest');
    });
    document.querySelectorAll('[data-back-to-login]').forEach((link) => {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        showView('login');
      });
    });

    resetRequestForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const status = document.getElementById('resetRequestStatus');
      const button = resetRequestForm.querySelector('button[type="submit"]');
      button.disabled = true;
      status.classList.remove('error');
      status.textContent = 'Sending reset code…';
      try {
        resetEmail = resetRequestForm.elements.email.value.trim();
        const result = await postJson('/api/auth/forgot-password', { email: resetEmail });
        document.getElementById('resetAlert').textContent = result.message;
        status.textContent = '';
        showView('reset');
      } catch (error) {
        status.textContent = error.message;
        status.classList.add('error');
      } finally {
        button.disabled = false;
      }
    });

    resetForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const status = document.getElementById('resetStatus');
      const button = resetForm.querySelector('button[type="submit"]');
      status.classList.remove('error');
      if (resetForm.elements.newPassword.value !== resetForm.elements.confirmPassword.value) {
        status.textContent = 'New password and confirmation do not match.';
        status.classList.add('error');
        return;
      }
      button.disabled = true;
      status.textContent = 'Resetting password…';
      try {
        const result = await postJson('/api/auth/reset-password', {
          email: resetEmail,
          code: resetForm.elements.code.value,
          newPassword: resetForm.elements.newPassword.value
        });
        resetForm.reset();
        status.textContent = '';
        loginForm.elements.email.value = resetEmail;
        showView('login');
        loginNotice.textContent = result.message;
        loginNotice.hidden = false;
      } catch (error) {
        status.textContent = error.message;
        status.classList.add('error');
      } finally {
        button.disabled = false;
      }
    });

    document.getElementById('resendCode').addEventListener('click', async (event) => {
      if (!pendingCredentials) return showStep(1);
      const button = event.currentTarget;
      button.disabled = true;
      otpStatus.classList.remove('error');
      otpStatus.textContent = 'Sending a new code…';
      try {
        await requestCode(pendingCredentials);
        otpStatus.textContent = 'A new code was sent.';
      } catch (error) {
        otpStatus.textContent = error.message;
        otpStatus.classList.add('error');
      } finally {
        button.disabled = false;
      }
    });

    otpForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = otpForm.querySelector('button[type="submit"]');
      button.disabled = true;
      otpStatus.textContent = 'Verifying one-time code…';
      try {
        const result = await postJson('/api/auth/otp', {
          challengeId,
          code: otpForm.elements.code.value
        });
        const next = new URLSearchParams(window.location.search).get('next');
        let redirectTo = result.redirectTo || '/verify';
        if (next && next.startsWith('/') && !next.startsWith('//')) {
          const candidate = new URL(next, window.location.origin);
          if (candidate.origin === window.location.origin && candidate.pathname !== '/login' && candidate.pathname !== '/auth') {
            redirectTo = `${candidate.pathname}${candidate.search}${candidate.hash}`;
          }
        }
        window.location.assign(redirectTo);
      } catch (error) {
        otpStatus.textContent = error.message;
        otpStatus.classList.add('error');
      } finally {
        button.disabled = false;
      }
    });
  }

  const registrationForm = document.getElementById('employerForm');
  if (registrationForm) {
    const status = document.getElementById('registrationStatus');
    registrationForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = registrationForm.querySelector('button[type="submit"]');
      button.disabled = true;
      status.textContent = 'Submitting employer registration…';
      try {
        const data = Object.fromEntries(new FormData(registrationForm).entries());
        const documentFile = registrationForm.elements.businessDocument.files[0];
        if (documentFile && documentFile.size > 5 * 1024 * 1024) {
          throw new Error('The business document must be 5 MB or smaller.');
        }
        if (documentFile) {
          data.businessDocument = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('Unable to read the business document.'));
            reader.readAsDataURL(documentFile);
          });
        } else {
          data.businessDocument = '';
        }
        data.ageConfirmed = registrationForm.elements.ageConfirmed.checked;
        data.contentLiabilityAccepted = registrationForm.elements.contentLiabilityAccepted.checked;
        const result = await postJson('/api/employers', data);
        status.textContent = result.message;
        registrationForm.reset();
      } catch (error) {
        status.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });
  }
})();
