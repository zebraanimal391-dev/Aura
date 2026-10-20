/* Shared UI: page shells (public / customer / admin), badges, forms, tables, candlestick chart, error pages. */
'use strict';
const Live = { hooks: [] }; // per-page tick hooks, cleared on navigation

const ICON = { up: '▲', down: '▼' };
const STATUS_CLASS = { APPROVED: 'ok', SUCCEEDED: 'ok', PAID: 'ok', FILLED: 'ok', RESOLVED: 'ok', CLOSED: 'neutral', PROCESSED: 'ok', OPEN: 'info', IN_REVIEW: 'info', KYC_IN_REVIEW: 'info', PENDING: 'warn', UNDER_REVIEW: 'warn', REQUIRES_ACTION: 'warn', ACTION_REQUIRED: 'warn', PENDING_EMAIL_VERIFICATION: 'warn', KYC_PENDING: 'warn', SECOND_REVIEW: 'warn', ESCALATED: 'warn', WAITING_FOR_CUSTOMER: 'warn', PROFILE_INCOMPLETE: 'warn', EMAIL_VERIFIED: 'info', PROCESSING: 'info', CREATED: 'neutral', REQUESTED: 'neutral', IN_PROGRESS: 'info', FAILED: 'bad', REJECTED: 'bad', SUSPENDED: 'bad', RESTRICTED: 'bad', CANCELLED: 'neutral', EXPIRED: 'neutral', INVESTIGATION: 'bad', DUPLICATE: 'neutral', REFUNDED: 'neutral', DISPUTED: 'bad', RETURNED: 'bad', DECLINED: 'bad', PENDING_ACTION: 'warn' };
const badge = s => `<span class="badge ${STATUS_CLASS[s] || 'neutral'}">${esc(human(s))}</span>`;
const pnlHtml = (minor, id = '') => `<span class="${minor > 0 ? 'up' : minor < 0 ? 'down' : ''}" ${id}>${minor > 0 ? ICON.up + ' ' : minor < 0 ? ICON.down + ' ' : ''}${fmt(minor)}</span>`;
const demoTag = '<span class="demo-tag" title="Simulated funds and prices. No real money.">DEMO · SIMULATED</span>';

function fld(o) {
  const id = 'f_' + o.name, h = o.help ? `<small id="${id}_h" class="help">${o.help}</small>` : '';
  const attrs = `id="${id}" name="${o.name}" ${o.req ? 'required' : ''} ${o.attrs || ''} aria-describedby="${id}_h ${id}_e"`;
  let ctl;
  if (o.type === 'select') ctl = `<select ${attrs}>${o.options.map(x => { const v = Array.isArray(x) ? x[0] : x, l = Array.isArray(x) ? x[1] : x; return `<option value="${esc(v)}" ${String(o.value) === String(v) ? 'selected' : ''}>${esc(l)}</option>`; }).join('')}</select>`;
  else if (o.type === 'textarea') ctl = `<textarea ${attrs} rows="${o.rows || 4}">${esc(o.value || '')}</textarea>`;
  else if (o.type === 'checkbox') return `<div class="f chk"><label><input type="checkbox" ${attrs.replace(/aria-describedby="[^"]*"/, '')} ${o.value ? 'checked' : ''}> <span>${o.label}</span></label><span class="err" id="${id}_e" data-err="${o.name}" role="alert"></span></div>`;
  else ctl = `<input type="${o.type || 'text'}" value="${esc(o.value ?? '')}" ${attrs}>`;
  return `<div class="f"><label for="${id}">${o.label}${o.req ? ' <span aria-hidden="true">*</span>' : ''}</label>${ctl}${h}<span class="err" id="${id}_e" data-err="${o.name}" role="alert"></span></div>`;
}
const empty = (t, d, cta = '') => `<div class="empty"><h3>${esc(t)}</h3><p>${d}</p>${cta}</div>`;
const pageHead = (t, d = '', crumbs = '') => `<nav class="crumbs" aria-label="Breadcrumb">${crumbs}</nav><h1 id="main" tabindex="-1">${esc(t)}</h1>${d ? `<p class="lead">${d}</p>` : ''}`;
const card = (title, body, cls = '') => `<section class="card ${cls}">${title ? `<h2>${title}</h2>` : ''}${body}</section>`;
const kv = rows => `<dl class="kv">${rows.map(r => `<div><dt>${r[0]}</dt><dd>${r[1] ?? '—'}</dd></div>`).join('')}</dl>`;

/* ---------- tables: search, sort, pagination, empty/no-results, CSV export (permission checked by caller) ---------- */
const Tbl = {
  st: {},
  html(id, cols, rows, o = {}) {
    const s = this.st[id] || (this.st[id] = { q: '', p: 1, sort: null, dir: 1, f: '' }); const size = o.size || 10;
    let r = rows.slice();
    if (o.filter) r = r.filter(x => !s.f || o.filter.fn(x, s.f));
    if (s.q) r = r.filter(x => JSON.stringify(cols.map(c => c.text ? c.text(x) : x[c.k])).toLowerCase().includes(s.q.toLowerCase()));
    if (s.sort) { const c = cols.find(c => c.label === s.sort); const v = x => c.sortv ? c.sortv(x) : x[c.k]; r.sort((a, b) => (v(a) > v(b) ? 1 : v(a) < v(b) ? -1 : 0) * s.dir); }
    const pages = Math.max(1, Math.ceil(r.length / size)); s.p = Math.min(s.p, pages); const slice = r.slice((s.p - 1) * size, s.p * size);
    const tools = `<form data-form="tbl" class="tools" role="search"><input type="hidden" name="id" value="${id}"><label class="sr" for="q_${id}">Search</label><input id="q_${id}" name="q" type="search" placeholder="Search…" value="${esc(s.q)}">${o.filter ? `<label class="sr" for="f_${id}">Filter</label><select id="f_${id}" name="f" data-autosubmit="1"><option value="">${o.filter.label || 'All'}</option>${o.filter.opts.map(x => `<option ${s.f === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>` : ''}<button class="btn small">Search</button>${(s.q || s.f) ? `<button class="btn small ghost" data-act="tblclear" data-id="${id}" type="button">Clear</button>` : ''}${o.export ? `<button type="button" class="btn small ghost" data-act="tblexport" data-id="${id}">Export CSV</button>` : ''}</form>`;
    if (o.export) this.exp[id] = { cols, rows: r, name: o.export };
    const head = cols.map(c => `<th scope="col" ${c.sortable !== false && !c.noSort ? `aria-sort="${s.sort === c.label ? (s.dir > 0 ? 'ascending' : 'descending') : 'none'}"` : ''}>${c.noSort ? esc(c.label) : `<button class="thb" data-act="tblsort" data-id="${id}" data-c="${esc(c.label)}">${esc(c.label)}</button>`}</th>`).join('');
    const body = slice.length ? slice.map(x => `<tr>${cols.map(c => `<td data-l="${esc(c.label)}">${c.fmt ? c.fmt(x) : esc(x[c.k] ?? '—')}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${cols.length}">${rows.length ? 'No results match your search or filter.' : (o.empty || 'Nothing to show yet.')}</td></tr>`;
    return `${tools}<div class="tw"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div><div class="pager"><span>${r.length} item${r.length === 1 ? '' : 's'}</span><span><button class="btn small ghost" data-act="tblpage" data-id="${id}" data-p="${s.p - 1}" ${s.p <= 1 ? 'disabled' : ''}>Previous</button> Page ${s.p} of ${pages} <button class="btn small ghost" data-act="tblpage" data-id="${id}" data-p="${s.p + 1}" ${s.p >= pages ? 'disabled' : ''}>Next</button></span></div>`;
  },
  exp: {}
};
Frm.tbl = (f, d) => { const s = Tbl.st[d.id] || (Tbl.st[d.id] = {}); s.q = d.q || ''; s.f = d.f || ''; s.p = 1; Router.run(); };
Act.tblpage = t => { Tbl.st[t.dataset.id].p = +t.dataset.p; Router.run(); };
Act.tblclear = t => { Object.assign(Tbl.st[t.dataset.id], { q: '', f: '', p: 1 }); Router.run(); };
Act.tblsort = t => { const s = Tbl.st[t.dataset.id]; s.dir = s.sort === t.dataset.c ? -s.dir : 1; s.sort = t.dataset.c; Router.run(); };
Act.tblexport = t => { // CSV export; callers only render the button for permitted roles, and exports by staff are audited
  const e = Tbl.exp[t.dataset.id]; const strip = h => String(h ?? '').replace(/<[^>]+>/g, '').replace(/"/g, '""');
  const csv = [e.cols.map(c => c.label), ...e.rows.map(r => e.cols.map(c => c.text ? c.text(r) : r[c.k]))].map(r => r.map(x => `"${strip(x)}"`).join(',')).join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = e.name + '.csv'; a.click();
  const ad = Auth.admin(); if (ad) Audit.log({ actor: ad.id, role: ad.role, action: 'export.csv', target: e.name, after: { rows: e.rows.length } });
};

/* ---------- candlestick chart (canvas) with crosshair, wheel zoom, drag pan, reset ---------- */
function attachChart(canvas, getSym, getTf, tip) {
  const st = { bars: 70, off: 0, mx: null }; canvas._st = st;
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  function draw() {
    const sym = getSym(), arr = Market.candles(sym, getTf()); const dpr = window.devicePixelRatio || 1; const W = canvas.clientWidth, H = canvas.clientHeight;
    if (canvas.width !== W * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; } const g = canvas.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const end = arr.length - st.off, start = Math.max(0, end - st.bars), v = arr.slice(start, end); if (!v.length) return;
    const hi = Math.max(...v.map(c => c.h)), lo = Math.min(...v.map(c => c.l)), pad = (hi - lo) * 0.08 || 1e-4, top = hi + pad, bot = lo - pad, R = 64, B = 18;
    const Y = p => (H - B) * (1 - (p - bot) / (top - bot)), w = (W - R) / v.length;
    g.font = '11px ui-monospace,monospace'; g.fillStyle = css('--muted'); g.strokeStyle = css('--line'); g.lineWidth = 1;
    for (let i = 0; i <= 5; i++) { const p = bot + (top - bot) * i / 5, y = Y(p); g.beginPath(); g.moveTo(0, y); g.lineTo(W - R, y); g.stroke(); g.fillText(Market.fmt(sym, p), W - R + 6, y + 4); }
    const up = css('--up'), dn = css('--down');
    v.forEach((c, i) => { const x = i * w + w / 2, col = c.c >= c.o ? up : dn; g.strokeStyle = g.fillStyle = col; g.beginPath(); g.moveTo(x, Y(c.h)); g.lineTo(x, Y(c.l)); g.stroke(); const y1 = Y(Math.max(c.o, c.c)), y2 = Y(Math.min(c.o, c.c)); g.fillRect(x - w * 0.34, y1, w * 0.68, Math.max(1, y2 - y1)); });
    const last = v[v.length - 1].c, yl = Y(last); g.strokeStyle = css('--accent'); g.setLineDash([4, 3]); g.beginPath(); g.moveTo(0, yl); g.lineTo(W - R, yl); g.stroke(); g.setLineDash([]); g.fillStyle = css('--accent'); g.fillRect(W - R, yl - 9, R, 18); g.fillStyle = '#fff'; g.fillText(Market.fmt(sym, last), W - R + 4, yl + 4);
    if (st.mx !== null && st.mx < W - R) { const i = Math.min(v.length - 1, Math.max(0, Math.floor(st.mx / w))), c = v[i]; g.strokeStyle = css('--muted'); g.setLineDash([2, 3]); g.beginPath(); g.moveTo(i * w + w / 2, 0); g.lineTo(i * w + w / 2, H - B); g.stroke(); g.setLineDash([]); if (tip) tip.textContent = `O ${Market.fmt(sym, c.o)}  H ${Market.fmt(sym, c.h)}  L ${Market.fmt(sym, c.l)}  C ${Market.fmt(sym, c.c)}`; } else if (tip) tip.textContent = 'Hover the chart for OHLC · wheel to zoom · drag to pan';
  }
  canvas.addEventListener('mousemove', e => { st.mx = e.offsetX; if (st.drag != null) { st.off = Math.max(0, st.off + Math.round((e.offsetX - st.drag) / 6)); st.drag = e.offsetX; } draw(); });
  canvas.addEventListener('mouseleave', () => { st.mx = null; st.drag = null; draw(); }); canvas.addEventListener('mousedown', e => st.drag = e.offsetX); window.addEventListener('mouseup', () => st.drag = null);
  canvas.addEventListener('wheel', e => { e.preventDefault(); st.bars = Math.min(150, Math.max(15, st.bars + (e.deltaY > 0 ? 6 : -6))); draw(); }, { passive: false });
  canvas._reset = () => { st.bars = 70; st.off = 0; draw(); }; canvas._draw = draw; draw(); Live.hooks.push(draw); window.addEventListener('resize', draw); Router.cleanup.push(() => window.removeEventListener('resize', draw));
}
document.addEventListener('change', e => { if (e.target.matches('[data-autosubmit]')) e.target.form.requestSubmit(); });
Act.reload = () => location.reload();
Act.print = () => window.print();
Act.chartreset = () => $('#chart')?._reset();

/* ---------- navigation maps ---------- */
const PUBLIC_NAV = [['Products', '/products'], ['Markets', '/markets-overview'], ['Pricing', '/pricing'], ['Learn', '/learn'], ['About', '/about'], ['Help', '/help']];
const APP_NAV = [
  ['Overview', [['Dashboard', '/app'], ['Account status', '/app/verification']]],
  ['Markets', [['Market overview', '/app/markets'], ['Watchlist & alerts', '/app/watchlist'], ['Charts', '/app/charts'], ['Calendar & news', '/app/news']]],
  ['Demo trading', [['Terminal & positions', '/app/trade'], ['Order history', '/app/orders']]],
  ['Wallet', [['Wallet overview', '/app/wallet'], ['Deposit', '/app/deposit'], ['Withdraw', '/app/withdraw'], ['Transactions', '/app/transactions'], ['Statements', '/app/statements']]],
  ['Verification', [['Identity checklist', '/app/verification']]],
  ['Notifications', [['Inbox & preferences', '/app/notifications']]],
  ['Help', [['Contact support', '/app/support'], ['Service status', '/status']]],
  ['Account', [['Profile', '/app/profile'], ['Security & sessions', '/app/security'], ['Preferences', '/app/preferences'], ['Legal documents', '/app/legal'], ['Close account', '/app/close-account']]]
];
const ADMIN_NAV = [
  ['Overview', [['Admin overview', '/admin', null]]],
  ['Customers', [['All users', '/admin/users', 'users.view'], ['Closure requests', '/admin/closures', 'closures.decide']]],
  ['Verification', [['KYC queue', '/admin/kyc', 'kyc.view']]],
  ['Payments', [['Payment intents', '/admin/payments', 'payments.view'], ['Webhook events', '/admin/webhooks', 'payments.view'], ['Refunds', '/admin/refunds', 'payments.view']]],
  ['Withdrawals', [['Withdrawal queue', '/admin/withdrawals', 'withdrawals.view']]],
  ['Finance', [['Ledger', '/admin/ledger', 'ledger.view'], ['Reconciliation', '/admin/recon', 'recon.view'], ['Manual adjustments', '/admin/adjustments', 'adjust.request']]],
  ['Customer service', [['Ticket queue', '/admin/tickets', 'tickets.view']]],
  ['Website content', [['Announcements & FAQs', '/admin/content', 'content.edit']]],
  ['Integrations', [['Providers & health', '/admin/integrations', 'settings.view']]],
  ['System', [['Roles & admins', '/admin/roles', 'users.view'], ['Fees, limits & flags', '/admin/config', 'settings.view'], ['Audit log', '/admin/audit', 'audit.view']]],
  ['My admin profile', [['MFA & sessions', '/admin/profile', null]]]
];

const Shell = {
  theme(pref) { pref = pref || Auth.me()?.prefs?.theme || localStorage.getItem('aura_theme') || 'system'; const dark = pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches); document.documentElement.dataset.theme = dark ? 'dark' : 'light'; },
  banner(ctx) {
    const s = Settings.get(); const ann = DB.get('content_ann').filter(a => a.status === 'PUBLISHED');
    return `<div class="demobar" role="note"><strong>DEMO ONLY.</strong> AuraFX is a simulator: prices are randomly generated, funds have no cash value, and no real money or live trades are involved.</div>${s.maintenance ? '<div class="maint" role="alert">Scheduled maintenance is in progress. Deposits, withdrawals and trading are temporarily unavailable.</div>' : ''}${ann.map(a => `<div class="ann" role="note"><strong>${esc(a.title)}</strong> ${esc(a.text)}</div>`).join('')}`;
  },
  footer() {
    const L = CFG.legal; return `<footer class="foot"><div class="wrap fgrid"><div><b>${esc(CFG.brand)}</b><p>${esc(CFG.legalEntity)}<br>${esc(CFG.registeredAddress)}</p><p class="small">${esc(CFG.licenceInfo)}</p></div>
    <div><b>Legal</b><a href="#/legal/terms">Terms of Service / Client Agreement</a><a href="#/legal/risk">Risk Disclosure</a><a href="#/legal/privacy">Privacy Notice</a><a href="#/legal/cookies">Cookie Notice</a><button class="linkbtn" data-act="cookieprefs">Cookie preferences</button><a href="#/legal/fees">Fees and charges</a><a href="#/legal/complaints">Complaints procedure</a></div>
    <div><b>Policies</b><a href="#/legal/eligibility">Restricted countries &amp; eligibility</a><a href="#/legal/execution">Execution &amp; conflicts policy</a><a href="#/legal/fraud">Responsible use &amp; anti-fraud</a><a href="#/legal/accessibility">Accessibility statement</a></div>
    <div><b>Company</b><a href="#/about">About &amp; contact</a><a href="#/status">Service status</a><a href="#/help">Help centre</a></div></div>
    <div class="wrap small">© ${new Date().getFullYear()} ${esc(CFG.brand)} · v${CFG.version} · Legal documents v${L.terms} dated ${L.date}. <strong>Risk warning:</strong> trading foreign exchange carries a high risk of loss. This site is a simulator and offers no real trading.</div></footer>`;
  },
  cookie() {
    if (localStorage.getItem('aura_cookie')) return '';
    return `<div class="cookie" role="dialog" aria-label="Cookie notice"><p>We use only essential storage (sign-in session, theme, preferences). No analytics or advertising cookies are used. <a href="#/legal/cookies">Learn more</a></p><button class="btn small primary" data-act="cookieok">OK</button> <button class="btn small ghost" data-act="cookieprefs">Preferences</button></div>`;
  },
  header(kind, ctx) {
    const me = ctx.user, ad = ctx.admin;
    const right = kind === 'public' ? (Auth.me() ? `<a class="btn small primary" href="#/app">Dashboard</a>` : `<a class="btn small ghost" href="#/login">Log in</a><a class="btn small primary" href="#/register">Create account</a>`) : kind === 'app' ? `<span class="who">${esc(me.profile?.display || me.name.split(' ')[0])}</span><a class="iconlink" href="#/app/notifications" aria-label="Notifications">🔔<span class="dot" ${DB.get('notifications').some(n => n.uid === me.id && !n.read) ? '' : 'hidden'}></span></a><button class="btn small ghost" data-act="logout">Log out</button>` : `<span class="who">${esc(ad.name)} · ${esc(ROLE_LABEL[ad.role])}</span><button class="btn small ghost" data-act="adminlogout">Sign out</button>`;
    const nav = kind === 'public' ? PUBLIC_NAV.map(n => `<a href="#${n[1]}">${n[0]}</a>`).join('') : '';
    return `<a class="skip" href="#main">Skip to content</a><header class="top"><div class="wrap hbar"><button class="menubtn" data-act="menu" aria-label="Open menu" aria-expanded="false">☰</button><a class="logo" href="#/" aria-label="${esc(CFG.brand)} home"><i>A</i>${esc(CFG.brand)}</a><nav class="pnav" aria-label="Main">${nav}</nav><span class="grow"></span>${kind === 'app' ? demoTag : ''}<button class="iconbtn" data-act="theme" aria-label="Change theme (system, light, dark)" title="Theme">☾</button>${right}</div></header>`;
  },
  page(layout, html, ctx = {}, opts = {}) {
    Shell.theme(); const root = $('#app'); const user = Auth.me(); ctx.user = ctx.user || null;
    let body;
    if (layout === 'app') {
      const nav = APP_NAV.map(g => `<div class="ng"><div class="nt">${g[0]}</div>${g[1].map(l => `<a href="#${l[1]}" ${location.hash.slice(1).split('?')[0] === l[1] ? 'aria-current="page"' : ''}>${l[0]}</a>`).join('')}</div>`).join('');
      body = `${this.header('app', ctx)}${this.banner(ctx)}<div class="shell"><aside class="side" id="side" aria-label="Account navigation">${nav}<button class="btn small ghost" data-act="logout">Log out</button></aside><main class="content" ${ctx.maintenance ? '' : ''}>${ctx.maintenance ? '<div class="maint">Maintenance mode: money and trading actions are blocked.</div>' : ''}${html}</main></div>`;
    } else if (layout === 'admin') {
      const ad = ctx.admin; const nav = ADMIN_NAV.map(g => { const ls = g[1].filter(l => !l[2] || Auth.can(ad, l[2])); return ls.length ? `<div class="ng"><div class="nt">${g[0]}</div>${ls.map(l => `<a href="#${l[1]}" ${location.hash.slice(1).split('?')[0] === l[1] ? 'aria-current="page"' : ''}>${l[0]}</a>`).join('')}</div>` : ''; }).join('');
      body = `${this.header('admin', ctx)}<div class="shell admin"><aside class="side" id="side" aria-label="Admin navigation">${nav}</aside><main class="content">${html}</main></div>`;
    } else if (layout === 'bare') body = `${this.header('public', ctx)}${this.banner(ctx)}<main class="wrap narrow">${html}</main>`;
    else body = `${this.header('public', ctx)}${this.banner(ctx)}<main class="wrap">${html}</main>${this.footer()}`;
    root.innerHTML = body + this.cookie();
    const mh = $('#main'); if (!mh) { const h = $('main h1'); if (h) { h.id = 'main'; h.tabIndex = -1; } }
  }
};
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => Shell.theme());

Act.menu = t => { const s = $('#side') || $('.pnav'); const open = s.classList.toggle('open'); t.setAttribute('aria-expanded', open); };
document.addEventListener('click', e => { if (e.target.closest('.side a, .pnav a')) { $('#side')?.classList.remove('open'); $('.pnav')?.classList.remove('open'); } });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { $('#side')?.classList.remove('open'); $('.pnav')?.classList.remove('open'); } });
Act.theme = () => { const cur = Auth.me()?.prefs?.theme || localStorage.getItem('aura_theme') || 'system'; const n = { system: 'light', light: 'dark', dark: 'system' }[cur]; localStorage.setItem('aura_theme', n); const u = Auth.me(); if (u) Auth.savePrefs(u.id, { theme: n }); Shell.theme(n); toast('Theme: ' + n); };
Act.cookieok = () => { localStorage.setItem('aura_cookie', JSON.stringify({ necessary: true, ts: now(), v: CFG.legal.cookies })); $('.cookie')?.remove(); };
Act.cookieprefs = async () => { const r = await confirmBox('Cookie preferences', '<p>AuraFX uses only <strong>strictly necessary</strong> browser storage (session, theme, cookie choice). No analytics or marketing cookies are set, so there is nothing optional to switch on.</p>', 'Save choice'); if (r) Act.cookieok(); };
Act.logout = () => { Auth.logout('customer'); toast('You have been signed out.'); Router.go('/'); };
Act.adminlogout = () => { Auth.logout('admin'); Router.go('/admin/login'); };

const ErrorPages = {
  e404: () => `<div class="center"><h1 id="main" tabindex="-1">404 – Page not found</h1><p>The page you are looking for does not exist or has moved.</p><a class="btn primary" href="#/">Back to home</a></div>`,
  e403: () => `<div class="center"><h1 id="main" tabindex="-1">403 – Not permitted</h1><p>Your role does not include permission for this area. If you think this is a mistake, ask a super administrator. (Permissions are enforced server-side too; hiding a menu item is not access control.)</p><a class="btn primary" href="#/admin">Admin overview</a></div>`,
  e429: () => `<div class="center"><h1 id="main" tabindex="-1">429 – Too many requests</h1><p>Please wait a moment and try again.</p></div>`,
  crash: e => `<div class="center"><h1 id="main" tabindex="-1">Something went wrong</h1><p>The service is temporarily unavailable. Your data was not changed. Please retry.</p><button class="btn primary" data-act="reload">Reload</button><pre class="small">${esc(e.message)}</pre></div>`
};
