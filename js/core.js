/* Core: helpers, browser-storage "database", audit log, router, dialogs, toasts.
   DEMO NOTE: localStorage stands in for a server database. It is NOT secure storage. See docs/ARCHITECTURE.md. */
'use strict';
const CFG = window.AURA_CONFIG;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => Date.now();
const rtoken = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
const rid = (p = '') => p + now().toString(36).toUpperCase().slice(-5) + crypto.getRandomValues(new Uint32Array(1))[0].toString(36).toUpperCase().slice(0, 5);
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async t => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)));
async function pbkdf2(pw, salt) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 150000, hash: 'SHA-256' }, k, 256));
}

/* ---------- storage ---------- */
const DB = {
  get(k, d = []) { try { const v = localStorage.getItem('aura_' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { localStorage.setItem('aura_' + k, JSON.stringify(v)); },
  add(k, o) { const a = DB.get(k); a.push(o); DB.set(k, a); return o; },
  upd(k, id, p) { const a = DB.get(k), i = a.findIndex(x => x.id === id); if (i < 0) return null; a[i] = { ...a[i], ...(typeof p === 'function' ? p(a[i]) : p) }; DB.set(k, a); return a[i]; },
  byId(k, id) { return DB.get(k).find(x => x.id === id); }
};

/* ---------- global settings (admin-controlled) ---------- */
const Settings = {
  defaults: { maintenance: false, flags: { demoTrading: true, deposits: true, withdrawals: true, registrations: true },
    limits: { minDeposit: 1000, maxDeposit: 1000000, minWithdraw: 1000, maxWithdraw: 1000000, dualApproval: 500000 },
    fees: { depositPct: 0, withdrawFlat: 0 }, version: 1 },
  get() { const d = this.defaults, s = DB.get('settings', {}); return { ...d, ...s, flags: { ...d.flags, ...s.flags }, limits: { ...d.limits, ...s.limits }, fees: { ...d.fees, ...s.fees } }; },
  set(p) { const s = this.get(); const n = { ...s, ...p, version: s.version + 1 }; DB.set('settings', n); DB.add('settings_history', { id: rid('V'), ts: now(), snapshot: n }); return n; }
};

/* ---------- formatting ---------- */
const fmt = (minor, cur = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format((minor || 0) / 100);
const fmtN = (n, d = 2) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const userTz = () => { try { return (Auth.me()?.prefs?.tz) || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
function fdt(ts) {
  if (!ts) return '—';
  const tz = userTz();
  try { return new Date(ts).toLocaleString('en-GB', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }) + ' (' + tz + ')'; }
  catch { return new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'; }
}
const human = s => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, c => c.toUpperCase());
const countryName = c => (CFG.countries.find(x => x[0] === c) || [c, c])[1];

/* ---------- audit log (append-only, hash-chained so tampering is detectable) ---------- */
const Audit = {
  q: Promise.resolve(),
  log(e) {
    this.q = this.q.then(async () => {
      const a = DB.get('audit'); const prev = a.length ? a[a.length - 1].h : 'GENESIS';
      const rec = { id: rid('A'), ts: now(), outcome: 'success', corr: rid('C'), ...e };
      rec.h = await sha256(prev + JSON.stringify(rec)); a.push(rec); DB.set('audit', a);
    }).catch(console.error);
    return this.q;
  },
  async verify() {
    const a = DB.get('audit'); let prev = 'GENESIS';
    for (const x of a) { const { h, ...r } = x; if (await sha256(prev + JSON.stringify(r)) !== h) return { ok: false, badId: x.id }; prev = h; }
    return { ok: true, count: a.length };
  }
};

/* ---------- toasts / dialogs ---------- */
function toast(msg, type = 'info') {
  let c = $('#toasts'); if (!c) { c = document.createElement('div'); c.id = 'toasts'; c.setAttribute('role', 'status'); c.setAttribute('aria-live', 'polite'); document.body.append(c); }
  const t = document.createElement('div'); t.className = 'toast ' + type; t.textContent = msg; c.append(t);
  setTimeout(() => t.remove(), 5000);
}
function confirmBox(title, msg, ok = 'Confirm', danger = false) {
  return new Promise(res => {
    const d = document.createElement('dialog'); d.className = 'dlg'; d.setAttribute('aria-labelledby', 'dlgT');
    d.innerHTML = `<form method="dialog"><h2 id="dlgT">${esc(title)}</h2><div class="dlgmsg">${msg}</div><div class="actions"><button value="no" class="btn ghost">Cancel</button><button value="yes" class="btn ${danger ? 'danger' : 'primary'}">${esc(ok)}</button></div></form>`;
    d.addEventListener('close', () => { res(d.returnValue === 'yes'); d.remove(); });
    document.body.append(d); d.showModal();
  });
}
function promptBox(title, fields, ok = 'Submit') { // fields: [{name,label,type,options,required}] -> Promise<object|null>
  return new Promise(res => {
    const d = document.createElement('dialog'); d.className = 'dlg';
    const f = fields.map(x => x.type === 'select'
      ? `<div class="f"><label for="pb_${x.name}">${esc(x.label)}</label><select id="pb_${x.name}" name="${x.name}" ${x.required ? 'required' : ''}>${x.options.map(o => `<option value="${esc(o[0] ?? o)}">${esc(o[1] ?? o)}</option>`).join('')}</select></div>`
      : `<div class="f"><label for="pb_${x.name}">${esc(x.label)}</label>${x.type === 'textarea' ? `<textarea id="pb_${x.name}" name="${x.name}" rows="3" ${x.required ? 'required' : ''}></textarea>` : `<input id="pb_${x.name}" name="${x.name}" type="${x.type || 'text'}" ${x.required ? 'required' : ''} autocomplete="off">`}</div>`).join('');
    d.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2>${f}<div class="actions"><button value="no" formnovalidate class="btn ghost">Cancel</button><button value="yes" class="btn primary">${esc(ok)}</button></div></form>`;
    d.addEventListener('close', () => { res(d.returnValue === 'yes' ? Object.fromEntries(new FormData(d.querySelector('form'))) : null); d.remove(); });
    document.body.append(d); d.showModal();
  });
}

/* ---------- router ---------- */
const Act = {}, Frm = {}; // delegated click actions and form handlers (filled by other files)
const Router = {
  routes: [], cleanup: [],
  on(pat, opts, view) { const keys = []; const re = new RegExp('^' + pat.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$'); this.routes.push({ re, keys, opts, view }); },
  parse() { const h = location.hash.slice(1) || '/'; const [p, qs] = h.split('?'); return { path: (p.replace(/\/+$/, '') || '/'), q: Object.fromEntries(new URLSearchParams(qs || '')) }; },
  go(p) { if (location.hash.slice(1) === p) this.run(); else location.hash = p; },
  async run() {
    this.cleanup.forEach(f => { try { f(); } catch { } }); this.cleanup = []; if (typeof Live !== 'undefined') Live.hooks = [];
    const { path, q } = this.parse(); const root = $('#app');
    try {
      let r = this.routes.find(x => x.re.test(path));
      if (!r) return Shell.page('public', ErrorPages.e404());
      const m = path.match(r.re); const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const ctx = { path, q, params, user: null, admin: null };
      if (r.opts.area === 'customer') {
        ctx.user = Auth.me();
        if (!ctx.user) return this.go('/login?next=' + encodeURIComponent(path));
      }
      if (r.opts.area === 'admin') {
        ctx.admin = Auth.admin();
        if (!ctx.admin) return this.go('/admin/login');
        if (r.opts.perm && !Auth.can(ctx.admin, r.opts.perm)) return Shell.page('admin', ErrorPages.e403(), ctx, r.opts);
      }
      if (Settings.get().maintenance && r.opts.area === 'customer' && !r.opts.allowMaint) ctx.maintenance = true;
      const out = await r.view(ctx); const o = typeof out === 'string' ? { html: out } : out;
      Shell.page(r.opts.layout || 'public', o.html, ctx, r.opts);
      if (o.mount) o.mount();
      const mh = $('#main'); if (mh) { mh.focus({ preventScroll: true }); } window.scrollTo(0, 0);
    } catch (e) { console.error(e); Shell.page('public', ErrorPages.crash(e)); }
  }
};
window.addEventListener('hashchange', () => Router.run());

document.addEventListener('click', async e => {
  const t = e.target.closest('[data-act]'); if (!t) return;
  const fn = Act[t.dataset.act]; if (!fn) return;
  if (t.tagName === 'A' && !t.getAttribute('href')) e.preventDefault();
  try { await fn(t, e); } catch (err) { console.error(err); toast(err.message || 'Something went wrong. Please try again.', 'err'); }
});
document.addEventListener('submit', async e => {
  const f = e.target.closest('form[data-form]'); if (!f) return; e.preventDefault();
  const fn = Frm[f.dataset.form]; if (!fn) return;
  if (f.dataset.busy) return; f.dataset.busy = '1'; const btn = f.querySelector('button[type=submit],button:not([type])');
  if (btn) { btn.disabled = true; btn.dataset.l = btn.textContent; btn.textContent = 'Working…'; }
  try { await fn(f, Object.fromEntries(new FormData(f))); }
  catch (err) { console.error(err); toast(err.message || 'Request failed. Please retry.', 'err'); }
  finally { delete f.dataset.busy; if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = btn.dataset.l; } }
});
function setErr(form, name, msg) {
  const el = form.querySelector(`[data-err="${name}"]`); if (el) { el.textContent = msg || ''; }
  const inp = form.querySelector(`[name="${name}"]`); if (inp) inp.setAttribute('aria-invalid', msg ? 'true' : 'false');
}
function clearErrs(form) { $$('[data-err]', form).forEach(e => e.textContent = ''); $$('[aria-invalid]', form).forEach(e => e.removeAttribute('aria-invalid')); const b = form.querySelector('.formerr'); if (b) b.textContent = ''; }
function formErr(form, msg) { let b = form.querySelector('.formerr'); if (!b) { b = document.createElement('div'); b.className = 'formerr'; b.setAttribute('role', 'alert'); form.prepend(b); } b.textContent = msg; }
