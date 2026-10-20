/* Node test for the simulated backend rules. Run: node tests/backend.test.js */
const fs = require('fs'), path = require('path'), vm = require('vm');
const store = {}; const mk = () => ({ getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => delete store[k] });
const sess = {}; const ctx = { process, console, setTimeout, setInterval: () => 0, clearInterval() {}, crypto: require('crypto').webcrypto, TextEncoder, Intl, Date, Math, JSON, Promise, URLSearchParams, Blob,
  localStorage: mk(), sessionStorage: { getItem: k => sess[k] ?? null, setItem: (k, v) => sess[k] = v, removeItem: k => delete sess[k] },
  navigator: { userAgent: 'node-test' }, location: { href: 'http://x/#/', hash: '' }, matchMedia: () => ({ matches: false, addEventListener() {} }),
  document: { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], documentElement: { dataset: {} } }, addEventListener() {}, innerHeight: 0 };
ctx.window = ctx; vm.createContext(ctx);
for (const f of ['config', 'market', 'core', 'api-auth', 'api-finance']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/' + f + '.js'), 'utf8').replace(/^'use strict';/m, '') + '\n', ctx, { filename: f });
const run = c => vm.runInContext(c, ctx);
Object.assign(ctx, { __assert: (c, m) => { if (!c) { console.error('FAIL:', m); process.exitCode = 1; } else console.log('ok  -', m); } });
run(`(async () => {
const t = __assert; Market.start && 0;
// admins
const sr = await Auth.adminSetup('Root', 'root@x.com', 'Sup3rLongSecret77X'); if (!sr.ok) console.log('SETUP', sr); const a1 = DB.get('admins')[0];
let r = await Auth.createAdmin(a1, { name: 'Fin', email: 'fin@x.com', role: 'finance', password: 'FinanceUser12345', reason: 't' }); t(r.ok, 'create finance admin');
r = await Auth.createAdmin(a1, { name: 'Comp1', email: 'c1@x.com', role: 'compliance', password: 'ComplianceOne1234', reason: 't' });
r = await Auth.createAdmin(a1, { name: 'Comp2', email: 'c2@x.com', role: 'compliance', password: 'ComplianceTwo1234', reason: 't' });
r = await Auth.createAdmin(a1, { name: 'Fin2', email: 'fin2@x.com', role: 'finance', password: 'FinanceUser22345', reason: 't' });
const [, fin, c1, c2, fin2] = DB.get('admins'); t(!(await Auth.createAdmin(fin, { name: 'x', email: 'z@x.com', role: 'support', password: 'Abcdefghijkl12345' })).ok, 'finance cannot create admins');
// registration validation
r = await Auth.register({ name: 'Al', email: 'bad', phone: '1', country: 'IR', dob: '2015-01-01', password: 'x', password2: 'y' }); t(!r.ok && r.errors.country && r.errors.dob && r.errors.terms, 'registration rejects restricted country / minor / weak input');
const reg = { name: 'Ada Lovelace', email: 'Ada@Example.com', phone: '+441234567890', country: 'NG', dob: '1990-05-05', password: 'CorrectHorse123', password2: 'CorrectHorse123', terms: 'on', risk: 'on' };
r = await Auth.register(reg); t(r.ok, 'register ok'); const u = Auth.byEmail('ada@example.com'); t(u.status === 'PENDING_EMAIL_VERIFICATION', 'pending verification');
r = await Auth.register(reg); t(r.ok && DB.get('users').length === 1, 'duplicate registration looks identical and creates no second account');
t(!(await Auth.login('ada@example.com', 'CorrectHorse123')).ok, 'cannot login unverified');
const link = DB.get('mailbox').find(m => m.body.includes('verify-email')).body.match(/t=([a-f0-9]+)/)[1];
t((await Auth.verifyEmail(link)).ok, 'verify email'); t(!(await Auth.verifyEmail(link)).ok, 'verification link single-use');
t(!(await Auth.login('ada@example.com', 'wrong')).ok, 'wrong password generic fail');
r = await Auth.login('ada@example.com', 'CorrectHorse123'); t(r.ok && Auth.me()?.id === u.id, 'login creates session');
t(!Acct.caps(Auth.me()).withdraw, 'no withdrawal before KYC');
// onboarding
await Auth.saveProfile(u.id, { address: '1 Main', city: 'London', postcode: 'E1' }); await Auth.sendPhoneCode(u.id);
const code = DB.get('mailbox').filter(m => m.ch === 'sms').pop().body.match(/code is (\\d{6})/)[1]; t(!(await Auth.verifyPhone(u.id, '000000')).ok, 'wrong phone code rejected'); t((await Auth.verifyPhone(u.id, code)).ok, 'phone verified');
t(Auth.user(u.id).status === 'KYC_PENDING', 'status KYC_PENDING after onboarding');
t(!Kyc.submit(u.id, 'Passport', [{ name: 'a.exe', size: 10, type: 'application/x-msdownload' }]).ok, 'KYC rejects bad file type');
const k = Kyc.submit(u.id, 'Passport', [{ name: 'p.pdf', size: 1000, type: 'application/pdf' }]); t(k.ok, 'KYC submit');
t(!(await Kyc.decide(fin, k.id, { decision: 'approve', reason: 'DOCS_OK' })).ok, 'finance role cannot decide KYC');
t(!(await Kyc.decide(c1, k.id, { decision: 'approve' })).ok, 'reason code mandatory');
r = await Kyc.decide(c1, k.id, { decision: 'approve', reason: 'DOCS_OK' }); t(r.pending && Auth.user(u.id).status !== 'APPROVED', 'high-risk: first approval does not approve');
t(!(await Kyc.decide(c1, k.id, { decision: 'approve', reason: 'DOCS_OK' })).ok, 'same reviewer cannot approve twice');
r = await Kyc.decide(c2, k.id, { decision: 'approve', reason: 'DOCS_OK' }); t(r.ok && Auth.user(u.id).kycApproved, 'second reviewer approves');
// deposits
const mkDep = async (amt, sc) => { const p = await Pay.create(u.id, amt, 'card', 'idem' + Math.random()); await SandboxProvider.pay(p.id, sc); return p.id; };
t(!(await Pay.create(u.id, 5, 'card', 'x1')).ok, 'deposit below minimum rejected');
const p0 = await Pay.create(u.id, 10000, 'card', 'same'); const p0b = await Pay.create(u.id, 10000, 'card', 'same'); t(p0b.dup && p0b.id === p0.id, 'idempotent create');
let ev = Webhook.build('payment.succeeded', DB.byId('payments', p0.id), 10000, 'evt_A'); 
r = await Webhook.receive(ev.raw, 'badsig'); t(r.result === 'FAILED' && Acct.balances(u.id).available === 0, 'invalid signature rejected, no credit');
await SandboxProvider.pay(p0.id, 'no_webhook'); t(DB.byId('payments', p0.id).status === 'REQUIRES_ACTION' && Acct.balances(u.id).available === 0, 'browser/return alone never credits');
await new Promise(r => setTimeout(r, 10)); r = await Pay.lookup(fin, p0.id); t(DB.byId('payments', p0.id).status === 'SUCCEEDED' && Acct.balances(u.id).available === 10000, 'status lookup recovers missing webhook, credits once');
r = await Pay.lookup(fin, p0.id); t(Acct.balances(u.id).available === 10000, 'repeat lookup does not double credit');
ev = Webhook.build('payment.succeeded', DB.byId('payments', p0.id), 10000, 'evt_DUP'); await Webhook.deliver(ev); const rr = await Webhook.deliver(ev); t(Acct.balances(u.id).available === 10000, 'duplicate event no second credit');
const pw = await Pay.create(u.id, 5000, 'card', 'w1'); await SandboxProvider.pay(pw.id, 'wrong_amount'); await new Promise(r => setTimeout(r, 1700)); t(DB.byId('payments', pw.id).status === 'REQUIRES_ACTION' && DB.byId('payments', pw.id).risk === 'AMOUNT_MISMATCH' && Acct.balances(u.id).available === 10000, 'wrong amount goes to investigation, not credited');
const pf = await Pay.create(u.id, 3000, 'card', 'f1'); const evf = Webhook.build('payment.failed', DB.byId('payments', pf.id), 3000, 'evt_F'); await Webhook.deliver(evf); t(DB.byId('payments', pf.id).status === 'FAILED', 'failed event handled');
const evs = Webhook.build('payment.succeeded', DB.byId('payments', pf.id), 3000, 'evt_S2'); await Webhook.deliver(evs); t(DB.byId('payments', pf.id).status === 'FAILED' && Acct.balances(u.id).available === 10000, 'out-of-order success after failure does not credit');
t(Ledger.trialBalance().ok, 'ledger balanced');
// withdrawals
await Wd.addDest(u.id, 'CorrectHorse123', 'Bank', 'GB00000012345678'); const d = DB.get('dests')[0];
t(!(await Wd.request(u.id, 99999999, d.id, 'wx')).ok, 'withdraw > balance rejected');
const w = await Wd.request(u.id, 4000, d.id, 'w1'); t(w.ok && Acct.balances(u.id).available === 6000 && Acct.balances(u.id).reserved === 4000, 'withdrawal reserves funds');
t((await Wd.request(u.id, 4000, d.id, 'w1')).dup, 'double submit idempotent'); t(Acct.balances(u.id).reserved === 4000, 'no second hold');
t(!Wd.decide(Auth.user ? c1 : c1, w.id, 'approve', 'ok').ok, 'compliance cannot approve withdrawals');
r = Wd.decide(fin, w.id, 'approve', 'ok'); t(r.ok && DB.byId('withdrawals', w.id).status === 'PROCESSING', 'single approval below threshold');
t(Acct.balances(u.id).reserved === 4000, 'approved is NOT paid; hold persists');
r = Wd.providerResult(fin, w.id, 'paid'); t(r.ok && Acct.balances(u.id).reserved === 0 && DB.byId('withdrawals', w.id).status === 'PAID', 'paid only after provider result');
Settings.set({ limits: { dualApproval: 1000 } }); const w2 = await Wd.request(u.id, 2000, d.id, 'w2'); Wd.decide(fin, w2.id, 'approve', 'ok'); t(DB.byId('withdrawals', w2.id).status === 'UNDER_REVIEW', 'dual approval: first approval waits');
t(!Wd.decide(fin, w2.id, 'approve', 'ok').ok, 'same approver blocked'); Wd.decide(fin2, w2.id, 'approve', 'ok'); t(DB.byId('withdrawals', w2.id).status === 'PROCESSING', 'second approver proceeds');
Wd.providerResult(fin, w2.id, 'failed'); t(Acct.balances(u.id).available === 4000 + 2000 && Acct.balances(u.id).reserved === 0, 'failed payout releases hold via ledger');
// adjustments
const aj = Adjust.request(fin, { uid: u.id, amount: 500, reason: 'goodwill', evidence: 'TK1' }); t(aj.ok, 'adjustment requested'); const aid = DB.get('adjustments')[0].id; t(!Adjust.decide(fin, aid, true).ok, 'cannot approve own adjustment'); t(Adjust.decide(fin2, aid, true).ok, 'other approver ok');
// refund
const pr = await mkDep(2000, 'succeed'); await new Promise(r => setTimeout(r, 1700)); t(DB.byId('payments', pr).status === 'SUCCEEDED', 'sandbox success webhook credits'); t((await Pay.refund(fin, pr, 'test')).ok && DB.byId('payments', pr).status === 'REFUNDED', 'refund via separate ledger entry'); t(!(await Pay.refund(fin, pr, 'again')).ok, 'no double refund');
// trading
Market.start; const before = Trade.account(u.id).balance;
const o = Trade.place(u.id, { sym: 'EURUSD', side: 'buy', type: 'market', lots: 0.01, sl: '', tp: '' }); t(o.ok && Trade.openPos(u.id).length === 1, 'market order fills');
t(!Trade.place(u.id, { sym: 'EURUSD', side: 'buy', type: 'market', lots: 50 }).ok, 'size limit enforced'); t(!Trade.place(u.id, { sym: 'EURUSD', side: 'buy', type: 'market', lots: 0.01, sl: 9 }).ok, 'SL wrong side rejected');
const pos = Trade.openPos(u.id)[0]; Trade.close(pos.id); t(Trade.openPos(u.id).length === 0, 'position closes'); t(Ledger.trialBalance().ok, 'ledger still balanced after trades');
// restrictions
await Usr.setStatus(c1, u.id, 'SUSPENDED', 'FRAUD_RISK', ''); t(!Acct.caps(Auth.user(u.id)).deposit && !(await Pay.create(u.id, 5000, 'card', 'susp')).ok, 'suspended cannot deposit');
t(!(await Usr.setStatus(fin, u.id, 'ACTIVE', 'POLICY')).ok, 'finance cannot change account status');
const av = await Audit.verify(); t(av.ok && av.count > 10, 'audit chain valid (' + av.count + ' events)');
const log = DB.get('audit'); log[3].action = 'tampered'; DB.set('audit', log); t(!(await Audit.verify()).ok, 'tampering detected');
console.log('DONE');
})().catch(e => { console.error('EXC', e); process.exitCode = 1; });`);
