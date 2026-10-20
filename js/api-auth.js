/* SIMULATED BACKEND (part 1): accounts, sessions, MFA, KYC, admin RBAC.
   Every rule that the spec says the "backend decides" lives in these functions, never in the UI code.
   In production these become server routes (see docs/api.md). Passwords are PBKDF2-hashed here, but
   browser storage is still NOT a secure place for credentials or sessions. */
'use strict';
const fail = (code, error, extra = {}) => ({ ok: false, code, error, ...extra });
const okr = (d = {}) => ({ ok: true, ...d });

const ROLE_PERMS = {
  super_admin: ['*'],
  compliance: ['users.view', 'users.restrict', 'notes.add', 'kyc.view', 'kyc.decide', 'audit.view', 'tickets.view', 'closures.decide', 'notify.send'],
  finance: ['users.view', 'payments.view', 'payments.refund', 'withdrawals.view', 'withdrawals.approve', 'ledger.view', 'recon.view', 'adjust.request', 'adjust.approve', 'export', 'settings.view'],
  support: ['users.view', 'notes.add', 'tickets.view', 'tickets.reply', 'notify.send'],
  content: ['content.edit'],
  auditor: ['users.view', 'kyc.view', 'payments.view', 'withdrawals.view', 'ledger.view', 'recon.view', 'audit.view', 'tickets.view', 'settings.view', 'export']
};
const ROLE_LABEL = { super_admin: 'Super administrator', compliance: 'Compliance reviewer', finance: 'Finance operator', support: 'Support agent', content: 'Content editor', auditor: 'Auditor (read-only)' };

const Mail = { send(to, subject, body, ch = 'email') { DB.add('mailbox', { id: rid('M'), to, subject, body, ch, ts: now() }); } };
const Notify = { push(uid, cat, title, text, link = '') { DB.add('notifications', { id: rid('N'), uid, cat, title, text, link, ts: now(), read: false }); } };
const SecEv = { log(uid, type, detail = '') { DB.add('secevents', { id: rid('E'), uid, type, detail, ts: now(), ua: navigator.userAgent.slice(0, 70) }); } };
const baseUrl = () => location.href.split('#')[0];

const Rate = {
  check(k) { const r = DB.get('rate', {})[k]; return r && r.until > now() ? Math.ceil((r.until - now()) / 1000) : 0; },
  fail(k, max = 5, lock = 60000) { const a = DB.get('rate', {}); const r = a[k] || { c: 0, until: 0 }; r.c++; if (r.c >= max) { r.until = now() + lock; r.c = 0; } a[k] = r; DB.set('rate', a); },
  clear(k) { const a = DB.get('rate', {}); delete a[k]; DB.set('rate', a); }
};

const COMMON_PW = ['password', 'passw0rd', '123456', 'qwerty', 'letmein', 'welcome', 'admin', 'iloveyou', 'aurafx'];
function pwIssues(pw, email = '', min = 12) {
  const i = []; pw = pw || '';
  if (pw.length < min) i.push(`at least ${min} characters`);
  if (!/[a-z]/.test(pw)) i.push('a lowercase letter'); if (!/[A-Z]/.test(pw)) i.push('an uppercase letter'); if (!/\d/.test(pw)) i.push('a number');
  if (COMMON_PW.some(c => pw.toLowerCase().includes(c))) i.push('no common/compromised words');
  if (email && pw.toLowerCase().includes(email.split('@')[0].toLowerCase()) && email.split('@')[0].length > 3) i.push('not containing your email name');
  return i;
}

/* ---------- sessions ---------- */
const Sess = {
  create(kind, sub) { const tok = rtoken(); DB.add('sessions', { id: rid('S'), tok, kind, sub, created: now(), last: now(), ua: navigator.userAgent.slice(0, 90), revoked: false }); sessionStorage.setItem('aura_' + kind, tok); return tok; },
  cur(kind) {
    const t = sessionStorage.getItem('aura_' + kind); if (!t) return null;
    const s = DB.get('sessions').find(x => x.tok === t && !x.revoked); if (!s) return null;
    const idle = (kind === 'admin' ? CFG.session.adminIdleMin : CFG.session.idleMin) * 60000;
    if (now() - s.last > idle || now() - s.created > CFG.session.absoluteHrs * 3600000) { this.end(s.id); return null; }
    return s;
  },
  touch(kind) { const s = this.cur(kind); if (s && now() - s.last > 15000) DB.upd('sessions', s.id, { last: now() }); },
  end(id) { DB.upd('sessions', id, { revoked: true }); },
  revokeAll(uid, exceptId) { const a = DB.get('sessions'); a.forEach(s => { if (s.sub === uid && s.id !== exceptId) s.revoked = true; }); DB.set('sessions', a); },
  idleLeft(kind) { const s = this.cur(kind); return s ? (kind === 'admin' ? CFG.session.adminIdleMin : CFG.session.idleMin) * 60000 - (now() - s.last) : 0; }
};

/* ---------- one-time tokens / codes ---------- */
const Tok = {
  async issue(kind, uid, mins) { const t = rtoken(); DB.add('tokens', { id: rid('T'), kind, uid, h: await sha256(t), exp: now() + mins * 60000, used: false }); return t; },
  async consume(kind, t) { const h = await sha256(t || ''); const r = DB.get('tokens').find(x => x.kind === kind && x.h === h); if (!r) return fail('INVALID', 'This link is not valid.'); if (r.used) return fail('USED', 'This link has already been used.'); if (r.exp < now()) return fail('EXPIRED', 'This link has expired.'); DB.upd('tokens', r.id, { used: true }); return okr({ uid: r.uid }); }
};

/* ---------- account capabilities (server-side policy) ---------- */
const EARLY = ['EMAIL_VERIFIED', 'PROFILE_INCOMPLETE', 'KYC_PENDING', 'KYC_IN_REVIEW', 'ACTION_REQUIRED', 'REJECTED'];
const Acct = {
  caps(u) {
    if (!u || u.status === 'CLOSED' || u.status === 'SUSPENDED' || u.status === 'PENDING_EMAIL_VERIFICATION') return { view: true, deposit: false, trade: false, withdraw: false };
    let c = u.kycApproved ? { view: true, deposit: true, trade: true, withdraw: true } : (EARLY.includes(u.status) ? { view: true, deposit: true, trade: true, withdraw: false } : { view: true, deposit: false, trade: false, withdraw: false });
    if (u.status === 'RESTRICTED') { const r = u.restrict || {}; c = { view: true, deposit: c.deposit && !r.deposit, trade: c.trade && !r.trade, withdraw: c.withdraw && !r.withdraw }; }
    return c;
  },
  why(u, cap) {
    const s = u.status;
    if (s === 'SUSPENDED') return 'Your account is suspended. Please contact support.';
    if (s === 'RESTRICTED') return 'Some features on your account are restricted. Please contact support for details.';
    if (s === 'PENDING_EMAIL_VERIFICATION') return 'Verify your email address to unlock this feature.';
    if (cap === 'withdraw' && !u.kycApproved) return 'Withdrawals unlock after your identity verification is approved.';
    return 'This feature is not available for your account right now.';
  },
  recompute(uid) { // advance early onboarding states only; approval can never be set here
    const u = DB.byId('users', uid); if (!u || !EARLY.concat(['PENDING_EMAIL_VERIFICATION']).includes(u.status)) return u;
    if (['KYC_IN_REVIEW', 'ACTION_REQUIRED', 'REJECTED'].includes(u.status)) return u;
    const p = u.profile || {}; const complete = p.address && p.city && p.postcode;
    const s = !u.emailVerified ? 'PENDING_EMAIL_VERIFICATION' : (complete && u.phoneVerified) ? 'KYC_PENDING' : (p.address || p.city || u.phoneVerified) ? 'PROFILE_INCOMPLETE' : 'EMAIL_VERIFIED';
    return DB.upd('users', uid, { status: s });
  },
  balances(uid) { return { available: Ledger.bal('u:' + uid + ':avail'), reserved: Ledger.bal('u:' + uid + ':resv') }; }
};

/* ---------- authentication ---------- */
const Auth = {
  user: id => DB.byId('users', id),
  byEmail(e) { e = (e || '').trim().toLowerCase(); return DB.get('users').find(u => u.email === e); },
  me() { const s = Sess.cur('customer'); if (!s) return null; const u = this.user(s.sub); if (!u || u.status === 'CLOSED') { Sess.end(s.id); return null; } return u; },
  admin() { const s = Sess.cur('admin'); if (!s) return null; const a = DB.byId('admins', s.sub); if (!a || a.disabled) { Sess.end(s.id); return null; } return a; },
  can(a, p) { const r = ROLE_PERMS[a.role] || []; return r.includes('*') || r.includes(p); },
  currentSessionId(kind) { return Sess.cur(kind)?.id; },

  async register(d) {
    if (d.website) return okr(); // honeypot: bots fill hidden field; pretend success
    if (!Settings.get().flags.registrations) return fail('CLOSED', 'Registration is temporarily unavailable.');
    const wait = Rate.check('reg'); if (wait) return fail('RATE', `Too many attempts. Try again in ${wait}s.`);
    Rate.fail('reg', 8, 300000);
    const e = {}; const email = (d.email || '').trim().toLowerCase(); const phone = (d.phone || '').replace(/[\s-]/g, '');
    if (!d.name || d.name.trim().length < 3 || !d.name.trim().includes(' ')) e.name = 'Enter your full legal name (first and last name).';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) e.email = 'Enter a valid email address.';
    if (!/^\+\d{7,15}$/.test(phone)) e.phone = 'Enter your number with country code, e.g. +441234567890.';
    if (!CFG.countries.some(c => c[0] === d.country)) e.country = 'Select your country of residence.';
    else if (CFG.restrictedCountries.includes(d.country)) e.country = 'Sorry, our services are not available in this country.';
    const dob = new Date(d.dob); const age = (Date.now() - dob) / 31557600000;
    if (!d.dob || isNaN(dob) || age > 120) e.dob = 'Enter a valid date of birth.'; else if (age < CFG.minAge) e.dob = `You must be at least ${CFG.minAge} years old.`;
    const pi = pwIssues(d.password, email); if (pi.length) e.password = 'Password needs: ' + pi.join(', ') + '.';
    if (d.password !== d.password2) e.password2 = 'Passwords do not match.';
    if (d.terms !== 'on') e.terms = 'You must accept the Terms of Service and Privacy Notice.';
    if (d.risk !== 'on') e.risk = 'You must acknowledge the Risk Disclosure.';
    if (Object.keys(e).length) { Rate.clear('reg'); return fail('INVALID', 'Please correct the highlighted fields.', { errors: e }); }
    const ex = this.byEmail(email);
    if (ex) { Mail.send(email, 'Someone tried to register with your email', `An attempt was made to create an AuraFX account with this address. If this was you, sign in or reset your password. If not, you can ignore this message.`); return okr(); } // same response: no account enumeration
    const salt = rtoken();
    const u = { id: rid('U'), email, phone, name: d.name.trim(), country: d.country, dob: d.dob, salt, hash: await pbkdf2(d.password, salt), status: 'PENDING_EMAIL_VERIFICATION', created: now(), emailVerified: false, phoneVerified: false, kycApproved: false, mfa: false, marketing: d.marketing === 'on', restrict: {}, profile: {}, prefs: { theme: 'system', tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', lang: 'en', display: 'USD', notif: { inapp: true, email: true, marketing: d.marketing === 'on', fills: true, margin: true } } };
    DB.add('users', u);
    DB.add('legal_acc', { id: rid('L'), uid: u.id, docs: { ...CFG.legal }, ts: now(), source: 'registration', marketing: u.marketing });
    SecEv.log(u.id, 'REGISTERED'); Audit.log({ actor: u.id, role: 'customer', action: 'user.register', target: u.id });
    await this.sendVerification(u);
    return okr();
  },
  async sendVerification(u) { const t = await Tok.issue('verify', u.id, 30); Mail.send(u.email, 'Verify your AuraFX email', `Welcome to AuraFX. Confirm your email within 30 minutes:\n${baseUrl()}#/verify-email?t=${t}`); },
  async resend(email) { const wait = Rate.check('resend:' + email); if (wait) return fail('RATE', `Please wait ${wait}s before requesting another email.`); Rate.fail('resend:' + email, 1, 60000); const u = this.byEmail(email); if (u && !u.emailVerified) await this.sendVerification(u); return okr(); },
  async verifyEmail(t) {
    const r = await Tok.consume('verify', t); if (!r.ok) return r;
    DB.upd('users', r.uid, { emailVerified: true, status: 'EMAIL_VERIFIED' }); Acct.recompute(r.uid);
    SecEv.log(r.uid, 'EMAIL_VERIFIED'); Notify.push(r.uid, 'verification', 'Email verified', 'Next: add your address, verify your phone and submit identity documents.', '#/app/verification');
    Audit.log({ actor: r.uid, role: 'customer', action: 'user.email_verified', target: r.uid }); return okr();
  },
  async sendPhoneCode(uid) {
    const wait = Rate.check('otp:' + uid); if (wait) return fail('RATE', `Please wait ${wait}s.`); Rate.fail('otp:' + uid, 1, 30000);
    const u = this.user(uid); const code = String(Math.floor(100000 + Math.random() * 900000));
    DB.add('otps', { id: rid('O'), uid, h: await sha256(code), exp: now() + 600000, tries: 0, used: false });
    Mail.send(u.phone, 'AuraFX verification code (SMS)', `Your AuraFX code is ${code}. It expires in 10 minutes. Never share it with anyone.`, 'sms'); return okr();
  },
  async verifyPhone(uid, code) {
    const o = DB.get('otps').filter(x => x.uid === uid && !x.used).pop(); if (!o) return fail('NOCODE', 'Request a new code first.');
    if (o.exp < now()) return fail('EXPIRED', 'This code has expired. Request a new one.'); if (o.tries >= 5) return fail('LOCKED', 'Too many wrong attempts. Request a new code.');
    if (o.h !== await sha256((code || '').trim())) { DB.upd('otps', o.id, { tries: o.tries + 1 }); return fail('WRONG', 'That code is incorrect.'); }
    DB.upd('otps', o.id, { used: true }); DB.upd('users', uid, { phoneVerified: true }); Acct.recompute(uid); SecEv.log(uid, 'PHONE_VERIFIED'); return okr();
  },
  async startMfa(kind, subj) {
    const code = String(Math.floor(100000 + Math.random() * 900000)); const id = rid('MF');
    DB.add('mfa', { id, kind, sub: subj.id, h: await sha256(code), exp: now() + 300000, tries: 0, used: false });
    Mail.send(subj.email, 'Your AuraFX sign-in code', `Your sign-in code is ${code}. It expires in 5 minutes. (Demo: production should use an authenticator app or passkey.)`); return okr({ mfa: id, kind });
  },
  async verifyMfa(id, code) {
    const c = DB.byId('mfa', id); if (!c || c.used || c.exp < now()) return fail('EXPIRED', 'This code has expired. Please sign in again.');
    if (c.tries >= 5) return fail('LOCKED', 'Too many attempts. Please sign in again.');
    if (c.h !== await sha256((code || '').trim())) { DB.upd('mfa', id, { tries: c.tries + 1 }); return fail('WRONG', 'That code is incorrect.'); }
    DB.upd('mfa', id, { used: true }); return this.finish(c.kind, c.kind === 'admin' ? DB.byId('admins', c.sub) : this.user(c.sub));
  },
  finish(kind, subj) {
    Sess.create(kind, subj.id); const col = kind === 'admin' ? 'admins' : 'users';
    DB.upd(col, subj.id, { prevLogin: subj.lastLogin || null, lastLogin: now() });
    if (kind === 'customer') SecEv.log(subj.id, 'LOGIN'); Audit.log({ actor: subj.id, role: kind === 'admin' ? subj.role : 'customer', action: kind + '.login', target: subj.id });
    return okr({ session: true });
  },
  async login(email, pw) {
    const key = 'login:' + (email || '').toLowerCase(); const wait = Rate.check(key); if (wait) return fail('RATE', `Too many attempts. Try again in ${wait}s.`);
    const u = this.byEmail(email); const h = await pbkdf2(pw || '', u ? u.salt : 'decoy');
    if (!u || u.hash !== h || u.status === 'CLOSED') { Rate.fail(key); if (u) SecEv.log(u.id, 'LOGIN_FAILED'); return fail('BAD', 'Invalid email or password.'); }
    Rate.clear(key);
    if (!u.emailVerified) return fail('UNVERIFIED', 'Please verify your email address first. Check your inbox for the link.', { email: u.email });
    return u.mfa ? this.startMfa('customer', u) : this.finish('customer', u);
  },
  logout(kind = 'customer') { const s = Sess.cur(kind); if (s) { Sess.end(s.id); if (kind === 'admin') Audit.log({ actor: s.sub, action: 'admin.logout', target: s.sub }); } sessionStorage.removeItem('aura_' + kind); },
  async forgot(email) {
    const wait = Rate.check('forgot'); if (wait) return fail('RATE', `Too many requests. Try again in ${wait}s.`); Rate.fail('forgot', 5, 300000);
    const u = this.byEmail(email);
    if (u && u.status !== 'CLOSED') { const t = await Tok.issue('reset', u.id, 30); Mail.send(u.email, 'Reset your AuraFX password', `Use this single-use link within 30 minutes:\n${baseUrl()}#/reset-password?t=${t}\nIf you did not request this, ignore this email.`); SecEv.log(u.id, 'RESET_REQUESTED'); }
    return okr(); // generic response either way
  },
  async reset(t, pw) {
    const prelim = await sha256(t || ''); const rec = DB.get('tokens').find(x => x.kind === 'reset' && x.h === prelim);
    if (rec && !rec.used && rec.exp > now()) { const u = this.user(rec.uid); const pi = pwIssues(pw, u.email); if (pi.length) return fail('POLICY', 'Password needs: ' + pi.join(', ') + '.'); }
    const r = await Tok.consume('reset', t); if (!r.ok) return r;
    const salt = rtoken(); const u = this.user(r.uid); DB.upd('users', u.id, { salt, hash: await pbkdf2(pw, salt) });
    Sess.revokeAll(u.id); SecEv.log(u.id, 'PASSWORD_RESET'); Mail.send(u.email, 'Your AuraFX password was changed', 'Your password was just reset and all sessions were signed out. If this was not you, contact support immediately.');
    Audit.log({ actor: u.id, role: 'customer', action: 'user.password_reset', target: u.id }); return okr();
  },
  async stepUp(uid, pw) { const u = this.user(uid); return !!u && u.hash === await pbkdf2(pw || '', u.salt); },
  async changePassword(uid, cur, nw) {
    const u = this.user(uid); if (!await this.stepUp(uid, cur)) return fail('BAD', 'Current password is incorrect.');
    const pi = pwIssues(nw, u.email); if (pi.length) return fail('POLICY', 'Password needs: ' + pi.join(', ') + '.');
    const salt = rtoken(); DB.upd('users', uid, { salt, hash: await pbkdf2(nw, salt) }); Sess.revokeAll(uid, Sess.cur('customer')?.id);
    SecEv.log(uid, 'PASSWORD_CHANGED'); Notify.push(uid, 'security', 'Password changed', 'Your password was changed and other sessions were signed out.'); return okr();
  },
  async saveProfile(uid, d) {
    const u = this.user(uid); const p = { address: (d.address || '').trim(), city: (d.city || '').trim(), postcode: (d.postcode || '').trim(), display: (d.display || '').trim() };
    DB.upd('users', uid, { profile: { ...u.profile, ...p } }); Acct.recompute(uid); SecEv.log(uid, 'PROFILE_UPDATED'); return okr();
  },
  async changePhone(uid, pw, phone) {
    if (!await this.stepUp(uid, pw)) return fail('BAD', 'Password is incorrect.'); phone = (phone || '').replace(/[\s-]/g, '');
    if (!/^\+\d{7,15}$/.test(phone)) return fail('INVALID', 'Enter the number with country code.');
    DB.upd('users', uid, { phone, phoneVerified: false }); Acct.recompute(uid); SecEv.log(uid, 'PHONE_CHANGED'); return okr();
  },
  setMfa(uid, on) { DB.upd('users', uid, { mfa: !!on }); SecEv.log(uid, on ? 'MFA_ENABLED' : 'MFA_DISABLED'); Notify.push(uid, 'security', 'Two-step sign-in ' + (on ? 'enabled' : 'disabled'), 'This is a security notification and cannot be switched off.'); return okr(); },
  savePrefs(uid, p) { const u = this.user(uid); DB.upd('users', uid, { prefs: { ...u.prefs, ...p, notif: { ...u.prefs.notif, ...(p.notif || {}) } } }); return okr(); },
  async requestClosure(uid, pw) {
    if (!await this.stepUp(uid, pw)) return fail('BAD', 'Password is incorrect.');
    const b = Acct.balances(uid); if (b.available > 0 || b.reserved > 0) return fail('BALANCE', 'Please withdraw or remove your remaining balance before closing the account.');
    if (DB.get('positions').some(p => p.uid === uid && p.status === 'OPEN') || DB.get('withdrawals').some(w => w.uid === uid && !['PAID', 'REJECTED', 'FAILED', 'CANCELLED', 'RETURNED'].includes(w.status))) return fail('OPEN', 'Close open positions and wait for pending withdrawals to finish first.');
    if (DB.get('closures').some(c => c.uid === uid && c.status === 'OPEN')) return fail('DUP', 'A closure request is already open.');
    DB.add('closures', { id: rid('CL'), uid, status: 'OPEN', ts: now() }); SecEv.log(uid, 'CLOSURE_REQUESTED'); return okr();
  },

  /* admin accounts */
  adminCount: () => DB.get('admins').length,
  async adminSetup(name, email, pw) {
    if (this.adminCount()) return fail('EXISTS', 'Setup already completed.'); const pi = pwIssues(pw, email, 14); if (pi.length) return fail('POLICY', 'Password needs: ' + pi.join(', ') + '.');
    const salt = rtoken(); const a = { id: rid('AD'), name, email: email.trim().toLowerCase(), role: 'super_admin', salt, hash: await pbkdf2(pw, salt), created: now(), disabled: false };
    DB.add('admins', a); Audit.log({ actor: a.id, role: 'super_admin', action: 'admin.bootstrap', target: a.id, reason: 'First-run setup' }); return okr();
  },
  async adminLogin(email, pw) {
    const key = 'alogin:' + (email || '').toLowerCase(); const wait = Rate.check(key); if (wait) return fail('RATE', `Too many attempts. Try again in ${wait}s.`);
    const a = DB.get('admins').find(x => x.email === (email || '').trim().toLowerCase()); const h = await pbkdf2(pw || '', a ? a.salt : 'decoy');
    if (!a || a.disabled || a.hash !== h) { Rate.fail(key, 4, 120000); Audit.log({ actor: a?.id || 'unknown', action: 'admin.login', target: email, outcome: 'failure' }); return fail('BAD', 'Invalid credentials.'); }
    Rate.clear(key); return this.startMfa('admin', a); // MFA is mandatory for every administrator
  },
  async createAdmin(actor, d) {
    if (!this.can(actor, 'admins.manage')) return fail('FORBIDDEN', 'Not permitted.');
    if (!ROLE_PERMS[d.role]) return fail('INVALID', 'Unknown role.'); const email = d.email.trim().toLowerCase(); if (DB.get('admins').some(a => a.email === email)) return fail('DUP', 'An administrator with this email exists. Shared accounts are not allowed.');
    const pi = pwIssues(d.password, email, 14); if (pi.length) return fail('POLICY', 'Password needs: ' + pi.join(', ') + '.');
    const salt = rtoken(); const a = { id: rid('AD'), name: d.name, email, role: d.role, salt, hash: await pbkdf2(d.password, salt), created: now(), disabled: false, createdBy: actor.id };
    DB.add('admins', a); Audit.log({ actor: actor.id, role: actor.role, action: 'admin.create', target: a.id, after: { email, role: d.role }, reason: d.reason }); return okr();
  },
  setAdminDisabled(actor, id, disabled, reason) {
    if (!this.can(actor, 'admins.manage')) return fail('FORBIDDEN', 'Not permitted.'); if (id === actor.id) return fail('SELF', 'You cannot disable your own account.');
    DB.upd('admins', id, { disabled }); if (disabled) Sess.revokeAll(id); Audit.log({ actor: actor.id, role: actor.role, action: disabled ? 'admin.disable' : 'admin.enable', target: id, reason }); return okr();
  }
};

/* ---------- admin actions on customers ---------- */
const Usr = {
  async setStatus(actor, uid, status, reason, notes, restrict) {
    if (!Auth.can(actor, 'users.restrict')) return fail('FORBIDDEN', 'You do not have permission for this action.');
    if (!reason) return fail('REASON', 'A reason code is required.');
    const u = Auth.user(uid); if (!u) return fail('NF', 'User not found.'); const before = { status: u.status, restrict: u.restrict };
    let ns = status; if (status === 'ACTIVE') ns = u.kycApproved ? 'APPROVED' : 'EMAIL_VERIFIED';
    DB.upd('users', uid, { status: ns, restrict: restrict || {} }); if (ns === 'SUSPENDED') Sess.revokeAll(uid); if (ns === 'EMAIL_VERIFIED') Acct.recompute(uid);
    const msg = { SUSPENDED: 'Your account has been suspended. Please contact support.', RESTRICTED: 'Some features on your account have been restricted. Please contact support.', APPROVED: 'Your account restrictions were lifted.', EMAIL_VERIFIED: 'Your account restrictions were lifted.' }[ns] || 'Your account status changed.';
    Notify.push(uid, 'account', 'Account update', msg); Audit.log({ actor: actor.id, role: actor.role, action: 'user.status', target: uid, before, after: { status: ns, restrict }, reason: reason + (notes ? ': ' + notes : '') }); return okr();
  },
  note(actor, uid, text) { if (!Auth.can(actor, 'notes.add')) return fail('FORBIDDEN', 'Not permitted.'); DB.add('notes', { id: rid('NT'), uid, by: actor.id, byName: actor.name, text, ts: now() }); Audit.log({ actor: actor.id, role: actor.role, action: 'user.note', target: uid }); return okr(); },
  notify(actor, uid, title, text) { if (!Auth.can(actor, 'notify.send')) return fail('FORBIDDEN', 'Not permitted.'); Notify.push(uid, 'support', title, text); Audit.log({ actor: actor.id, role: actor.role, action: 'user.notify', target: uid }); return okr(); },
  closure(actor, id, decision, reason) {
    if (!Auth.can(actor, 'closures.decide')) return fail('FORBIDDEN', 'Not permitted.'); const c = DB.byId('closures', id); if (!c || c.status !== 'OPEN') return fail('NF', 'Request not open.');
    DB.upd('closures', id, { status: decision === 'approve' ? 'APPROVED' : 'DECLINED', by: actor.id, decided: now() });
    if (decision === 'approve') { DB.upd('users', c.uid, { status: 'CLOSED' }); Sess.revokeAll(c.uid); }
    Audit.log({ actor: actor.id, role: actor.role, action: 'user.closure_' + decision, target: c.uid, reason }); return okr();
  }
};

/* ---------- KYC ---------- */
const Kyc = {
  OK_TYPES: ['application/pdf', 'image/jpeg', 'image/png'], MAX: 5 * 1024 * 1024,
  /* NOTE: only file METADATA is kept. Never store identity documents in browser storage. Production: private encrypted bucket + malware scan. */
  submit(uid, docType, files) {
    const u = Auth.user(uid); if (!u) return fail('NF', 'No account.'); if (!['KYC_PENDING', 'ACTION_REQUIRED', 'REJECTED'].includes(u.status)) return fail('STATE', u.status === 'KYC_IN_REVIEW' ? 'Your documents are already in review.' : 'Complete the earlier onboarding steps first (verified email, phone and address).');
    if (!files.length) return fail('FILES', 'Upload at least one document.');
    for (const f of files) { if (!this.OK_TYPES.includes(f.type)) return fail('TYPE', `${f.name}: only PDF, JPG or PNG files are accepted.`); if (f.size > this.MAX) return fail('SIZE', `${f.name}: file is larger than 5 MB.`); }
    const risk = CFG.highRiskCountries.includes(u.country) ? 'high' : 'standard';
    const c = { id: rid('K'), uid, status: 'IN_REVIEW', docType, docs: files.map(f => ({ name: f.name, size: f.size, type: f.type })), risk, approvals: [], history: [{ ts: now(), status: 'SUBMITTED', by: uid }], created: now(), customerMsg: '' };
    DB.add('kyc', c); DB.upd('users', uid, { status: 'KYC_IN_REVIEW' }); Audit.log({ actor: uid, role: 'customer', action: 'kyc.submit', target: c.id }); return okr({ id: c.id });
  },
  async decide(actor, id, d) { // d:{decision: approve|reject|info|escalate, reason, note, customerMsg}
    if (!Auth.can(actor, 'kyc.decide')) return fail('FORBIDDEN', 'You do not have permission to decide KYC cases.');
    const c = DB.byId('kyc', id); if (!c || !['IN_REVIEW', 'ESCALATED', 'SECOND_REVIEW'].includes(c.status)) return fail('STATE', 'This case is not open for decision.');
    if (!d.reason) return fail('REASON', 'A reason code is required for every decision.');
    const u = Auth.user(c.uid); const before = { case: c.status, user: u.status }; const hist = [...c.history, { ts: now(), status: d.decision.toUpperCase(), by: actor.id, reason: d.reason, note: d.note }];
    if (d.decision === 'approve') {
      if (c.risk === 'high') { // dual review: two different reviewers must approve
        if (c.approvals.includes(actor.id)) return fail('DUAL', 'Dual review required: a second, different reviewer must approve this high-risk case.');
        const ap = [...c.approvals, actor.id];
        if (ap.length < 2) { DB.upd('kyc', id, { approvals: ap, status: 'SECOND_REVIEW', history: hist }); Audit.log({ actor: actor.id, role: actor.role, action: 'kyc.approve_first', target: id, reason: d.reason }); return okr({ pending: true }); }
        c.approvals = ap;
      }
      DB.upd('kyc', id, { status: 'APPROVED', approvals: c.approvals.concat(c.risk === 'standard' ? [actor.id] : []), history: hist, decidedBy: actor.id, decided: now() });
      DB.upd('users', c.uid, { status: 'APPROVED', kycApproved: true }); Notify.push(c.uid, 'verification', 'Identity verified', 'Your verification is approved. Withdrawals are now available.', '#/app/wallet');
    } else if (d.decision === 'reject') { DB.upd('kyc', id, { status: 'REJECTED', history: hist, customerMsg: d.customerMsg || 'We could not verify your identity with the documents provided.', decidedBy: actor.id, decided: now() }); DB.upd('users', c.uid, { status: 'REJECTED', kycApproved: false }); Notify.push(c.uid, 'verification', 'Verification not approved', d.customerMsg || 'We could not verify your identity with the documents provided. You may submit new documents or contact support.', '#/app/verification'); }
    else if (d.decision === 'info') { DB.upd('kyc', id, { status: 'ACTION_REQUIRED', history: hist, customerMsg: d.customerMsg || 'Please provide clearer documents.' }); DB.upd('users', c.uid, { status: 'ACTION_REQUIRED' }); Notify.push(c.uid, 'verification', 'Action required', d.customerMsg || 'Please provide clearer documents.', '#/app/verification'); }
    else if (d.decision === 'escalate') DB.upd('kyc', id, { status: 'ESCALATED', history: hist });
    Audit.log({ actor: actor.id, role: actor.role, action: 'kyc.' + d.decision, target: id, before, after: { case: DB.byId('kyc', id).status }, reason: d.reason + (d.note ? ': ' + d.note : '') }); return okr();
  },
  viewDoc(actor, id, i) { if (!Auth.can(actor, 'kyc.view')) return fail('FORBIDDEN', 'Not permitted.'); Audit.log({ actor: actor.id, role: actor.role, action: 'kyc.document_view', target: id + '#' + i }); return okr(); }
};
