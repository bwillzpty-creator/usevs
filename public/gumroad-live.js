(function gumroadLive() {
  const params = new URLSearchParams(window.location.search);
  const plan = params.get('plan');
  const registrationForm = document.getElementById('employerForm');
  if (registrationForm && plan) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'plan';
    input.value = plan;
    registrationForm.append(input);
  }

  document.querySelectorAll('.card[data-plan] .button').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const code = { '1_day': '1day', '1_month': 'monthly', '1_year': 'yearly' }[link.closest('.card').dataset.plan];
      if (code) window.location.assign(`/checkout?plan=${encodeURIComponent(code)}`);
    });
  });

  if (window.location.pathname === '/payment-success') return;
  fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' })
    .then(async (response) => response.ok ? response.json() : null)
    .then((session) => {
      const main = document.querySelector('main');
      if (!session?.account?.email || !main) return;
      const identity = document.querySelector('[data-auth-account-email]') || document.createElement('p');
      if (!identity.hasAttribute('data-auth-account-email')) identity.setAttribute('data-auth-account-email', '');
      identity.textContent = `Signed in as ${session.account.email}`;
      identity.hidden = false;
      if (!identity.isConnected) main.prepend(identity);
    })
    .catch((error) => console.error('Unable to load signed-in account:', error));

  fetch('/api/gumroad/access', { credentials: 'same-origin', cache: 'no-store' })
    .then(async (response) => {
      if (response.status === 401 || response.status === 403) return null;
      const result = await response.json();
      return result.active ? null : result;
    })
    .then((result) => {
      if (!result || !result.banner || document.querySelector('[data-gumroad-banner]')) return;
      const banner = document.createElement('section');
      banner.setAttribute('data-gumroad-banner', '');
      banner.setAttribute('role', 'alert');
      banner.style.cssText = 'padding:16px;margin:12px 0;border:1px solid #f0b429;border-radius:8px;background:#3b2f0b;color:#fde68a';
      const message = document.createElement('p');
      message.textContent = result.banner;
      banner.append(message);
      for (const [label, plan, href] of [
        ['1-Day Pass', 'single_use', result.gumroadLinks?.singleUse],
        ['Monthly', 'monthly', result.gumroadLinks?.monthly],
        ['Yearly', 'yearly', result.gumroadLinks?.yearly]
      ]) {
        if (!href) continue;
        const link = document.createElement('a');
        link.href = `/checkout?plan=${encodeURIComponent(plan)}`;
        link.textContent = label;
        link.rel = 'noopener';
        link.style.cssText = 'margin-right:12px;color:#fdba74';
        banner.append(link);
      }
      document.querySelector('main')?.prepend(banner);
    })
    .catch((error) => console.error('Unable to load subscription status:', error));
})();
