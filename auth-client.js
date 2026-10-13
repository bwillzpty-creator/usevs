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
    const resetSent = document.getElementById('resetSent');
    const loginNotice = document.getElementById('loginNotice');

    function showView(view) {
      loginForm.hidden = view !== 'login';
      otpForm.hidden = true;
      resetRequestForm.hidden = view !== 'resetRequest';
      resetSent.hidden = view !== 'resetSent';
      registerHint.hidden = view !== 'login';
      heading.textContent = view === 'login' ? 'Sign in' : 'Reset password';
      loginNotice.hidden = true;
      if (view === 'login') loginForm.elements.email.focus({ preventScroll: true });
      if (view === 'resetRequest') resetRequestForm.elements.email.focus({ preventScroll: true });
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
      status.textContent = 'Sending reset link…';
      try {
        const result = await postJson('/api/auth/forgot-password', { email: resetRequestForm.elements.email.value.trim() });
        document.getElementById('resetSentMessage').textContent = result.message;
        status.textContent = '';
        showView('resetSent');
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
        window.location.assign(result.redirectTo || '/select-plan?required=1');
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
      status.textContent = 'Creating your account…';
      try {
        const data = Object.fromEntries(new FormData(registrationForm).entries());
        const result = await postJson('/api/employers', data);
        window.location.href = result.redirectTo || '/select-plan';
      } catch (error) {
        status.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });
  }
})();
