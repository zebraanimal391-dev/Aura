/* Registration, login, MFA, email verification, password recovery, admin login, demo mailbox. */
'use strict';
const authCard = (title, body, foot = '') => `<div class="authcard card"><h1 id="main" tabindex="-1">${esc(title)}</h1>${body}${foot ? `<p class="small center">${foot}</p>` : ''}</div>`;
const showFieldErrors = (f, errs) => { Object.entries(errs || {}).forEach(([k, v]) => setErr(f, k, v)); const first = $('[aria-invalid=true]', f); if (first) first.focus(); };

Router.on('/register', { layout: 'bare' }, () => {
  if (Auth.me()) return Router.go('/app');
  const opts = [['', 'Select country']].concat(CFG.countries.map(c => [c[0], c[1]]));
  return authCard('Create your demo account', `<p class="muted">Free simulator account. ${demoTag}</p>
<form data-form="register" novalidate autocomplete="on">
${fld({ label: 'Full legal name', name: 'name', req: 1, attrs: 'autocomplete="name"' })}
${fld({ label: 'Email address', name: 'email', type: 'email', req: 1, attrs: 'autocomplete="email"' })}
${fld({ label: 'Mobile number (with country code)', name: 'phone', type: 'tel', req: 1, help: 'Example: +441234567890', attrs: 'autocomplete="tel"' })}
${fld({ label: 'Country of residence', name: 'country', type: 'select', options: opts, req: 1 })}
${fld({ label: 'Date of birth', name: 'dob', type: 'date', req: 1, help: `You must be at least ${CFG.minAge}.`, attrs: 'autocomplete="bday"' })}
${fld({ label: 'Password', name: 'password', type: 'password', req: 1, help: 'At least 12 characters with upper-case, lower-case and a number.', attrs: 'autocomplete="new-password"' })}
${fld({ label: 'Confirm password', name: 'password2', type: 'password', req: 1, attrs: 'autocomplete="new-password"' })}
${fld({ type: 'checkbox', name: 'terms', label: `I accept the <a href="#/legal/terms" target="_blank">Terms of Service</a> (v${CFG.legal.terms}) and <a href="#/legal/privacy" target="_blank">Privacy Notice</a> (v${CFG.legal.privacy}).` })}
${fld({ type: 'checkbox', name: 'risk', label: `I have read the <a href="#/legal/risk" target="_blank">Risk Disclosure</a> (v${CFG.legal.risk}) and understand this is a simulator.` })}
${fld({ type: 'checkbox', name: 'marketing', label: 'Optional: send me product news and offers. (You can change this any time.)' })}
<div class="hp" aria-hidden="true"><label>Website<input name="website" tabindex="-1" autocomplete="off"></label></div>
<button class="btn primary block" type="submit">Create account</button></form>`, 'Already registered? <a href="#/login">Log in</a>');
});
Frm.register = async (f, d) => {
  clearErrs(f); const r = await Auth.register(d);
  if (!r.ok) { if (r.errors) showFieldErrors(f, r.errors); formErr(f, r.error); return; }
  $('main').innerHTML = authCard('Check your email', `<p>If the details are valid, we have sent a verification link to <strong>${esc(d.email)}</strong>. It expires in 30 minutes.</p><p class="muted small">Demo build: no real email is sent. Open the <a href="#/mailbox">demo mailbox</a> to read it.</p><p><a class="btn primary" href="#/mailbox">Open demo mailbox</a> <a class="btn ghost" href="#/login">Go to log in</a></p>`);
};

Router.on('/verify-email', { layout: 'bare' }, async c => {
  const r = await Auth.verifyEmail(c.q.t);
  return authCard(r.ok ? 'Email verified' : 'Verification problem', r.ok ? `<p>Your email address is confirmed. Sign in to continue onboarding.</p><a class="btn primary" href="#/login">Log in</a>` : `<p class="formerr">${esc(r.error)}</p><p>You can request a new link below.</p><form data-form="resend">${fld({ label: 'Email address', name: 'email', type: 'email', req: 1 })}<button class="btn primary">Send a new link</button></form>`);
});
Frm.resend = async (f, d) => { const r = await Auth.resend(d.email); r.ok ? toast('If that account needs verification, a new link was sent (check the demo mailbox).', 'ok') : toast(r.error, 'err'); };

Router.on('/login', { layout: 'bare' }, c => {
  if (Auth.me()) return Router.go(c.q.next || '/app');
  const notice = c.q.expired ? '<div class="maint" role="alert">Your session expired. Please sign in again.</div>' : '';
  return authCard('Log in', `${notice}<form data-form="login" novalidate>${fld({ label: 'Email address', name: 'email', type: 'email', req: 1, attrs: 'autocomplete="username"' })}${fld({ label: 'Password', name: 'password', type: 'password', req: 1, attrs: 'autocomplete="current-password"' })}<input type="hidden" name="next" value="${esc(c.q.next || '')}"><button class="btn primary block">Log in</button></form><p class="small center"><a href="#/forgot-password">Forgot password?</a></p>`, 'New here? <a href="#/register">Create an account</a>');
});
Frm.login = async (f, d) => {
  clearErrs(f); if (!d.email || !d.password) return formErr(f, 'Enter your email and password.');
  if (!navigator.onLine) return formErr(f, 'You appear to be offline. Check your connection and retry.');
  const r = await Auth.login(d.email, d.password);
  if (!r.ok) { formErr(f, r.error); if (r.code === 'UNVERIFIED') f.insertAdjacentHTML('beforeend', `<p class="small"><button type="button" class="linkbtn" data-act="resendv" data-email="${esc(r.email)}">Resend verification email</button></p>`); return; }
  if (r.mfa) return mfaScreen(r.mfa, d.next, 'customer');
  toast('Welcome back.', 'ok'); Router.go(d.next || '/app');
};
Act.resendv = async t => { const r = await Auth.resend(t.dataset.email); toast(r.ok ? 'Verification email sent (see demo mailbox).' : r.error, r.ok ? 'ok' : 'err'); };
function mfaScreen(id, next, kind) {
  $('main').innerHTML = authCard('Two-step verification', `<p>Enter the 6-digit code we sent you. <span class="small muted">(Demo: read it in the <a href="#/mailbox" target="_blank">demo mailbox</a>.)</span></p><form data-form="mfa"><input type="hidden" name="id" value="${id}"><input type="hidden" name="next" value="${esc(next || '')}"><input type="hidden" name="kind" value="${kind}">${fld({ label: 'Code', name: 'code', req: 1, attrs: 'inputmode="numeric" autocomplete="one-time-code" maxlength="6"' })}<button class="btn primary block">Verify</button></form>`);
}
Frm.mfa = async (f, d) => { clearErrs(f); const r = await Auth.verifyMfa(d.id, d.code); if (!r.ok) return setErr(f, 'code', r.error); Router.go(d.kind === 'admin' ? '/admin' : (d.next || '/app')); };

Router.on('/forgot-password', { layout: 'bare' }, () => authCard('Reset your password', `<form data-form="forgot" novalidate>${fld({ label: 'Email address', name: 'email', type: 'email', req: 1 })}<button class="btn primary block">Send reset link</button></form>`, '<a href="#/login">Back to log in</a>'));
Frm.forgot = async (f, d) => { const r = await Auth.forgot(d.email); if (!r.ok) return formErr(f, r.error); $('main').innerHTML = authCard('Check your email', `<p>If an account exists for that address, a single-use reset link is on its way. It expires in 30 minutes.</p><p class="small muted">Demo: see the <a href="#/mailbox">demo mailbox</a>.</p>`); };
Router.on('/reset-password', { layout: 'bare' }, c => authCard('Choose a new password', `<form data-form="reset" novalidate><input type="hidden" name="t" value="${esc(c.q.t || '')}">${fld({ label: 'New password', name: 'password', type: 'password', req: 1, help: 'At least 12 characters, mixed case and a number.', attrs: 'autocomplete="new-password"' })}${fld({ label: 'Confirm new password', name: 'password2', type: 'password', req: 1, attrs: 'autocomplete="new-password"' })}<button class="btn primary block">Reset password</button></form>`));
Frm.reset = async (f, d) => {
  clearErrs(f); if (d.password !== d.password2) return setErr(f, 'password2', 'Passwords do not match.');
  const r = await Auth.reset(d.t, d.password); if (!r.ok) return formErr(f, r.error + (['EXPIRED', 'USED', 'INVALID'].includes(r.code) ? ' Request a new link from the log-in page.' : ''));
  $('main').innerHTML = authCard('Password updated', '<p>Your password was changed and all other sessions were signed out. A notification was sent to you.</p><a class="btn primary" href="#/login">Log in</a>');
};

/* ---------- admin sign-in (separate from customer login; MFA mandatory) ---------- */
Router.on('/admin/login', { layout: 'bare' }, () => {
  if (Auth.admin()) return Router.go('/admin');
  if (!Auth.adminCount()) return authCard('First-run administrator setup', `<p class="muted">No administrator exists yet. Create the super administrator. There are no default credentials. (In production, provision admins through your identity provider.)</p><form data-form="adminsetup" novalidate>${fld({ label: 'Name', name: 'name', req: 1 })}${fld({ label: 'Email', name: 'email', type: 'email', req: 1 })}${fld({ label: 'Password', name: 'password', type: 'password', req: 1, help: 'Administrators need at least 14 characters.' })}<button class="btn primary block">Create super administrator</button></form>`);
  return authCard('Administrator sign-in', `<p class="muted small">Staff only. Every sign-in requires a one-time code (MFA) and is recorded in the audit log.</p><form data-form="adminlogin" novalidate>${fld({ label: 'Work email', name: 'email', type: 'email', req: 1 })}${fld({ label: 'Password', name: 'password', type: 'password', req: 1 })}<button class="btn primary block">Continue</button></form>`);
});
Frm.adminsetup = async (f, d) => { clearErrs(f); const r = await Auth.adminSetup(d.name, d.email, d.password); if (!r.ok) return formErr(f, r.error); toast('Super administrator created. Please sign in.', 'ok'); Router.run(); };
Frm.adminlogin = async (f, d) => { clearErrs(f); const r = await Auth.adminLogin(d.email, d.password); if (!r.ok) return formErr(f, r.error); mfaScreen(r.mfa, '', 'admin'); };

/* ---------- demo mailbox: stands in for email/SMS delivery so every flow can be tested ---------- */
Router.on('/mailbox', { layout: 'public' }, () => {
  const m = DB.get('mailbox').slice().reverse();
  return `${pageHead('Demo mailbox', 'Email and SMS messages the system "sent". In production these go through a trusted delivery provider.')}
<div class="maint" role="note">Demo-only page. Real systems must never expose messages like this. Clear it any time.</div>
<p><button class="btn small ghost" data-act="mailclear">Clear mailbox</button></p>
${m.length ? m.map(x => `<article class="card"><div class="small muted">${x.ch.toUpperCase()} to ${esc(x.to)} · ${fdt(x.ts)}</div><h3>${esc(x.subject)}</h3><p>${esc(x.body).replace(/\n/g, '<br>').replace(/(https?:\/\/[^\s<]+#\/[^\s<]+)/g, '<a href="$1">$1</a>')}</p></article>`).join('') : empty('Mailbox is empty', 'Messages from registration, verification and password recovery appear here.')}`;
});
Act.mailclear = () => { DB.set('mailbox', []); Router.run(); };
