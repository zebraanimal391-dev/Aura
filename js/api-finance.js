/* SIMULATED BACKEND (part 2): double-entry ledger, sandbox payments + signed webhooks, withdrawals,
   adjustments, support tickets and the DEMO trading simulator. No real money moves anywhere. */
'use strict';

/* ---------- double-entry ledger (integer minor units, idempotent by business reference) ---------- */
const Ledger = {
  txs: () => DB.get('ledger'),
  post(ref, type, lines, meta = {}) {
    if (this.txs().some(t => t.ref === ref)) return { dup: true };
    if (!lines.length || lines.some(l => !Number.isInteger(l.amt) || l.amt <= 0)) throw new Error('Ledger: amounts must be positive integers');
    const d = lines.filter(l => l.dir === 'D').reduce((a, l) => a + l.amt, 0), c = lines.filter(l => l.dir === 'C').reduce((a, l) => a + l.amt, 0);
    if (d !== c) throw new Error('Ledger: unbalanced transaction');
    const t = { id: rid('TX'), ref, type, ts: now(), lines, meta, cur: 'USD' }; DB.add('ledger', t); return t;
  },
  bal(acct) { return this.txs().reduce((s, t) => s + t.lines.filter(l => l.acct === acct).reduce((a, l) => a + (l.dir === 'C' ? l.amt : -l.amt), 0), 0); },
  forUser(uid) { return this.txs().filter(t => t.lines.some(l => l.acct.startsWith('u:' + uid + ':'))); },
  userDelta(t, uid) { return t.lines.filter(l => l.acct === 'u:' + uid + ':avail').reduce((a, l) => a + (l.dir === 'C' ? l.amt : -l.amt), 0); },
  trialBalance() { const all = this.txs(); const d = all.reduce((s, t) => s + t.lines.filter(l => l.dir === 'D').reduce((a, l) => a + l.amt, 0), 0), c = all.reduce((s, t) => s + t.lines.filter(l => l.dir === 'C').reduce((a, l) => a + l.amt, 0), 0); return { d, c, ok: d === c, n: all.length }; }
};
const guardMoney = u => { const s = Settings.get(); if (s.maintenance) return fail('MAINT', 'The service is in scheduled maintenance. Please try again later.'); return null; };

/* ---------- sandbox payment provider (stand-in for a hosted checkout) ---------- */
const DEMO_SIGNING_KEY = 'demo-only-sandbox-signing-key'; // In production the signing secret lives ONLY on the server.
const PAY_FLOW = { CREATED: ['REQUIRES_ACTION', 'CANCELLED', 'EXPIRED'], REQUIRES_ACTION: ['PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED'], PENDING: ['PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED'], PROCESSING: ['SUCCEEDED', 'FAILED'], SUCCEEDED: ['REFUNDED', 'DISPUTED'], FAILED: [], CANCELLED: [], EXPIRED: [], REFUNDED: [], DISPUTED: [] };
const PAY_FINAL = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED', 'REFUNDED', 'DISPUTED'];

const Pay = {
  METHODS: [{ id: 'bank', name: 'Bank transfer (sandbox)', time: '1–2 business days (simulated)' }, { id: 'card', name: 'Card via hosted checkout (sandbox)', time: 'Instant (simulated)' }],
  feeOf(amt) { return Math.round(amt * Settings.get().fees.depositPct / 100); },
  async create(uid, amount, method, idem) {
    const u = Auth.user(uid), s = Settings.get(); const g = guardMoney(u); if (g) return g;
    if (!s.flags.deposits) return fail('OFF', 'Deposits are currently disabled.'); if (!Acct.caps(u).deposit) return fail('DENIED', Acct.why(u, 'deposit'));
    if (!Number.isInteger(amount) || amount < s.limits.minDeposit || amount > s.limits.maxDeposit) return fail('LIMIT', `Amount must be between ${fmt(s.limits.minDeposit)} and ${fmt(s.limits.maxDeposit)}.`);
    if (!this.METHODS.some(m => m.id === method)) return fail('METHOD', 'Choose a payment method.');
    const ex = DB.get('payments').find(p => p.idem === idem); if (ex) return okr({ id: ex.id, dup: true }); // idempotent retry
    const fee = this.feeOf(amount); const id = rid('PI');
    const p = { id, uid, provider: 'sandbox', pref: 'sbx_' + rtoken().slice(0, 12), idem, amount, currency: 'USD', fee, net: amount - fee, method, status: 'CREATED', providerStatus: 'n/a', created: now(), expires: now() + 1800000, risk: 'none', ledgerTx: null, history: [{ ts: now(), status: 'CREATED', note: 'Payment intent recorded; no payment confirmation yet.' }], corr: rid('C') };
    DB.add('payments', p); DB.add('prov_payments', { pref: p.pref, intentId: id, amount, currency: 'USD', status: 'requires_action', events: [] });
    this.move(id, 'REQUIRES_ACTION', 'Provider checkout session created (server-side).'); Audit.log({ actor: uid, role: 'customer', action: 'payment.create', target: id }); return okr({ id });
  },
  move(id, status, note) { const p = DB.byId('payments', id); if (!p) return false; if (!PAY_FLOW[p.status].includes(status)) return false; DB.upd('payments', id, { status, history: [...p.history, { ts: now(), status, note }] }); return true; },
  expireStale() { DB.get('payments').forEach(p => { if (['CREATED', 'REQUIRES_ACTION'].includes(p.status) && p.expires < now()) this.move(p.id, 'EXPIRED', 'Checkout session expired.'); }); },
  /* Admin-triggered safe status lookup against the provider (used when a webhook never arrived) */
  async lookup(actor, id) {
    if (!Auth.can(actor, 'payments.view')) return fail('FORBIDDEN', 'Not permitted.'); const p = DB.byId('payments', id); const pp = DB.get('prov_payments').find(x => x.pref === p.pref);
    if (!pp || pp.status === 'requires_action') return okr({ msg: 'Provider reports no final outcome yet.' });
    const type = { succeeded: 'payment.succeeded', failed: 'payment.failed', cancelled: 'payment.cancelled' }[pp.status];
    const r = await Webhook.deliver(Webhook.build(type, p, pp.amount, 'lookup_' + p.pref + '_' + pp.status)); Audit.log({ actor: actor.id, role: actor.role, action: 'payment.lookup', target: id }); return okr({ msg: 'Provider status lookup processed: ' + r.result });
  },
  async refund(actor, id, reason) {
    if (!Auth.can(actor, 'payments.refund')) return fail('FORBIDDEN', 'You do not have permission to refund payments.'); if (!reason) return fail('REASON', 'A reason is required.');
    const p = DB.byId('payments', id); if (!p || p.status !== 'SUCCEEDED') return fail('STATE', 'Only succeeded payments can be refunded.');
    if (DB.get('refunds').some(r => r.paymentId === id)) return fail('DUP', 'This payment was already refunded.');
    if (Acct.balances(p.uid).available < p.net) return fail('FUNDS', 'The customer has already spent these funds. Open an investigation instead of forcing a refund.');
    Ledger.post('refund:' + id, 'REFUND', [{ acct: 'u:' + p.uid + ':avail', dir: 'D', amt: p.net }, ...(p.fee ? [{ acct: 'p:fees', dir: 'D', amt: p.fee }] : []), { acct: 'p:clearing', dir: 'C', amt: p.amount }], { paymentId: id });
    DB.add('refunds', { id: rid('RF'), paymentId: id, uid: p.uid, amount: p.amount, reason, by: actor.id, ts: now(), status: 'SUCCEEDED' }); this.move(id, 'REFUNDED', 'Refund recorded as a separate ledger event: ' + reason);
    Notify.push(p.uid, 'payment', 'Payment refunded', `Your deposit ${p.id} was refunded.`); Audit.log({ actor: actor.id, role: actor.role, action: 'payment.refund', target: id, reason }); return okr();
  }
};
const SandboxProvider = { // what the "hosted checkout" does after the customer chooses an outcome
  async pay(id, scenario) {
    const p = DB.byId('payments', id); if (!p) return fail('NF', 'Unknown payment.'); const pp = DB.get('prov_payments').find(x => x.pref === p.pref);
    if (pp.status !== 'requires_action') return fail('DONE', 'This checkout was already completed.');
    const outcome = scenario === 'decline' ? 'failed' : scenario === 'cancel' ? 'cancelled' : 'succeeded';
    pp.status = outcome; DB.set('prov_payments', DB.get('prov_payments').map(x => x.pref === pp.pref ? pp : x));
    const type = { succeeded: 'payment.succeeded', failed: 'payment.failed', cancelled: 'payment.cancelled' }[outcome];
    const amt = scenario === 'wrong_amount' ? p.amount + 100 : p.amount; const ev = Webhook.build(type, p, amt, 'evt_' + rtoken().slice(0, 12));
    if (scenario !== 'no_webhook') setTimeout(() => Webhook.deliver(ev), scenario === 'delayed' ? 8000 : 1500);
    if (scenario === 'duplicate') setTimeout(() => Webhook.deliver(ev), 2500);
    return okr();
  }
};
const Webhook = {
  build(type, p, amount, eid) { const body = JSON.stringify({ id: eid, type, data: { pref: p.pref, amount, currency: p.currency } }); return { raw: body, sig: null }; },
  async deliver(ev) { ev.sig = ev.sig || await sha256(DEMO_SIGNING_KEY + ev.raw); return this.receive(ev.raw, ev.sig); },
  /* Algorithm follows the spec: verify signature -> validate -> unique event id -> legal transition -> ledger once. */
  async receive(raw, sig) {
    const rec = { id: rid('WH'), received: now(), raw, signatureVerified: false, status: 'RECEIVED', note: '' };
    const save = (st, note, extra = {}) => { Object.assign(rec, { status: st, note }, extra); DB.add('prov_events', rec); return { result: st }; };
    if (sig !== await sha256(DEMO_SIGNING_KEY + raw)) return save('FAILED', 'Invalid signature: rejected, nothing processed.');
    rec.signatureVerified = true; let ev; try { ev = JSON.parse(raw); } catch { return save('FAILED', 'Malformed payload'); }
    rec.eventId = ev.id; rec.type = ev.type;
    if (DB.get('prov_events').some(e => e.eventId === ev.id && e.status === 'PROCESSED')) return save('DUPLICATE', 'Event already processed; no second credit.');
    const p = DB.get('payments').find(x => x.pref === ev.data.pref); if (!p) return save('INVESTIGATION', 'No matching internal payment.');
    rec.paymentId = p.id;
    if (ev.data.amount !== p.amount || ev.data.currency !== p.currency) { DB.upd('payments', p.id, { risk: 'AMOUNT_MISMATCH' }); return save('INVESTIGATION', `Amount/currency mismatch (event ${ev.data.amount} ${ev.data.currency} vs expected ${p.amount} ${p.currency}). Not credited.`); }
    const to = { 'payment.succeeded': 'SUCCEEDED', 'payment.failed': 'FAILED', 'payment.cancelled': 'CANCELLED' }[ev.type];
    if (!to) return save('PROCESSED', 'Event type ignored.');
    if (!PAY_FLOW[p.status].includes(to)) return save('INVESTIGATION', `Illegal transition ${p.status} -> ${to} (out-of-order or conflicting event). Confirmed outcome preserved.`);
    DB.upd('payments', p.id, { providerStatus: ev.type });
    if (to === 'SUCCEEDED') {
      const lines = [{ acct: 'p:clearing', dir: 'D', amt: p.amount }, { acct: 'u:' + p.uid + ':avail', dir: 'C', amt: p.net }]; if (p.fee) lines.push({ acct: 'p:fees', dir: 'C', amt: p.fee });
      const tx = Ledger.post('dep:' + p.id, 'DEPOSIT', lines, { paymentId: p.id }); DB.upd('payments', p.id, { ledgerTx: tx.id || DB.get('ledger').find(t => t.ref === 'dep:' + p.id)?.id, succeededAt: now() });
      Notify.push(p.uid, 'payment', 'Deposit confirmed', `${fmt(p.net)} of demo funds were credited. Reference ${p.id}.`, '#/app/transactions');
    } else Notify.push(p.uid, 'payment', 'Deposit ' + to.toLowerCase(), `Payment ${p.id} ${to.toLowerCase()}. No funds were credited.`);
    Pay.move(p.id, to, 'Verified webhook ' + ev.id); return save('PROCESSED', 'Applied ' + to);
  },
  async reprocess(actor, whId) {
    if (!Auth.can(actor, 'payments.view') || !Auth.can(actor, 'payments.refund') && actor.role !== 'super_admin') return fail('FORBIDDEN', 'Not permitted.');
    const e = DB.byId('prov_events', whId); if (!e || !e.signatureVerified) return fail('STATE', 'Only verified events can be reprocessed.'); const r = await this.receive(e.raw, await sha256(DEMO_SIGNING_KEY + e.raw));
    Audit.log({ actor: actor.id, role: actor.role, action: 'webhook.reprocess', target: whId }); return okr({ result: r.result });
  }
};

/* ---------- withdrawals ---------- */
const WD_OPEN = ['REQUESTED', 'UNDER_REVIEW', 'APPROVED', 'PROCESSING'];
const Wd = {
  async addDest(uid, pw, label, ident) {
    if (!await Auth.stepUp(uid, pw)) return fail('BAD', 'Password is incorrect.'); const c = (ident || '').replace(/\s/g, ''); if (c.length < 8) return fail('INVALID', 'Enter a valid account number / IBAN.');
    DB.add('dests', { id: rid('D'), uid, label: label || 'Bank account', masked: '••••' + c.slice(-4), verified: true, created: now() }); SecEv.log(uid, 'PAYOUT_DESTINATION_ADDED'); Notify.push(uid, 'security', 'Payout destination added', 'A new payout destination was added to your account.'); return okr();
  },
  async request(uid, amount, destId, idem) {
    const u = Auth.user(uid), s = Settings.get(); const g = guardMoney(u); if (g) return g;
    if (!s.flags.withdrawals) return fail('OFF', 'Withdrawals are currently disabled.'); if (!Acct.caps(u).withdraw) return fail('DENIED', Acct.why(u, 'withdraw'));
    const ex = DB.get('withdrawals').find(w => w.idem === idem); if (ex) return okr({ id: ex.id, dup: true });
    const d = DB.get('dests').find(x => x.id === destId && x.uid === uid); if (!d) return fail('DEST', 'Choose a verified payout destination.');
    if (!Number.isInteger(amount) || amount < s.limits.minWithdraw || amount > s.limits.maxWithdraw) return fail('LIMIT', `Amount must be between ${fmt(s.limits.minWithdraw)} and ${fmt(s.limits.maxWithdraw)}.`);
    const fee = s.fees.withdrawFlat; const open = DB.get('positions').some(p => p.uid === uid && p.status === 'OPEN');
    const id = rid('WD'); const avail = Acct.balances(uid).available - (open ? Trade.marginUsed(uid) : 0);
    if (amount + fee > avail) return fail('FUNDS', 'Insufficient available balance (open-position margin is excluded).');
    Ledger.post('wdhold:' + id, 'WITHDRAWAL_HOLD', [{ acct: 'u:' + uid + ':avail', dir: 'D', amt: amount + fee }, { acct: 'u:' + uid + ':resv', dir: 'C', amt: amount + fee }], { wd: id });
    DB.add('withdrawals', { id, uid, destId, amount, fee, net: amount, status: 'UNDER_REVIEW', idem, created: now(), approvals: [], history: [{ ts: now(), status: 'REQUESTED' }, { ts: now(), status: 'UNDER_REVIEW', note: 'Funds reserved; awaiting review.' }] });
    Audit.log({ actor: uid, role: 'customer', action: 'withdrawal.request', target: id }); return okr({ id });
  },
  release(w, status, note) { Ledger.post('wdrel:' + w.id, 'WITHDRAWAL_RELEASE', [{ acct: 'u:' + w.uid + ':resv', dir: 'D', amt: w.amount + w.fee }, { acct: 'u:' + w.uid + ':avail', dir: 'C', amt: w.amount + w.fee }], { wd: w.id }); this.mv(w.id, status, note); },
  mv(id, status, note) { const w = DB.byId('withdrawals', id); DB.upd('withdrawals', id, { status, history: [...w.history, { ts: now(), status, note }] }); },
  cancel(uid, id) { const w = DB.byId('withdrawals', id); if (!w || w.uid !== uid) return fail('NF', 'Not found.'); if (!['REQUESTED', 'UNDER_REVIEW'].includes(w.status)) return fail('STATE', 'This withdrawal can no longer be cancelled.'); this.release(w, 'CANCELLED', 'Cancelled by customer.'); return okr(); },
  decide(actor, id, decision, reason) {
    if (!Auth.can(actor, 'withdrawals.approve')) return fail('FORBIDDEN', 'You do not have permission to approve withdrawals.'); if (!reason) return fail('REASON', 'A reason is required.');
    const w = DB.byId('withdrawals', id); if (!w || w.status !== 'UNDER_REVIEW') return fail('STATE', 'Not awaiting review.'); const u = Auth.user(w.uid);
    if (decision === 'reject') { this.release(w, 'REJECTED', reason); Notify.push(w.uid, 'payment', 'Withdrawal declined', `Withdrawal ${id} was declined. Funds were released to your balance. Contact support for details.`); Audit.log({ actor: actor.id, role: actor.role, action: 'withdrawal.reject', target: id, reason }); return okr(); }
    if (!u.kycApproved) return fail('KYC', 'Customer identity is not approved.');
    if (w.approvals.includes(actor.id)) return fail('DUAL', 'You already approved this. A second, different approver is required.');
    const ap = [...w.approvals, actor.id]; const need = w.amount >= Settings.get().limits.dualApproval ? 2 : 1;
    if (ap.length < need) { DB.upd('withdrawals', id, { approvals: ap }); Audit.log({ actor: actor.id, role: actor.role, action: 'withdrawal.approve_first', target: id, reason }); return okr({ pending: true }); }
    DB.upd('withdrawals', id, { approvals: ap }); this.mv(id, 'APPROVED', 'Authorised; not yet sent.'); this.mv(id, 'PROCESSING', 'Submitted to payout provider (sandbox) with idempotency key ' + w.idem);
    Audit.log({ actor: actor.id, role: actor.role, action: 'withdrawal.approve', target: id, reason }); return okr();
  },
  /* sandbox payout provider outcome; "paid" is recorded ONLY from provider confirmation, never from approval */
  providerResult(actor, id, result) {
    if (!Auth.can(actor, 'withdrawals.approve')) return fail('FORBIDDEN', 'Not permitted.'); const w = DB.byId('withdrawals', id); if (!w || w.status !== 'PROCESSING') return fail('STATE', 'Not processing.');
    if (result === 'paid') { Ledger.post('wdpaid:' + id, 'WITHDRAWAL_PAID', [{ acct: 'u:' + w.uid + ':resv', dir: 'D', amt: w.amount + w.fee }, { acct: 'p:payout', dir: 'C', amt: w.amount }, ...(w.fee ? [{ acct: 'p:fees', dir: 'C', amt: w.fee }] : [])], { wd: id }); this.mv(id, 'PAID', 'Provider confirmed payout (sandbox).'); Notify.push(w.uid, 'payment', 'Withdrawal paid', `Withdrawal ${id} was paid.`); }
    else { this.release(w, result === 'returned' ? 'RETURNED' : 'FAILED', 'Provider reported ' + result + '; hold released through a recorded ledger entry.'); Notify.push(w.uid, 'payment', 'Withdrawal ' + result, `Withdrawal ${id} ${result}. Funds were returned to your balance.`); }
    Audit.log({ actor: actor.id, role: actor.role, action: 'withdrawal.provider_' + result, target: id }); return okr();
  }
};
const Adjust = { // manual adjustments: separate ledger entry, evidence, reason, dual approval, limit
  LIMIT: 100000,
  request(actor, d) {
    if (!Auth.can(actor, 'adjust.request')) return fail('FORBIDDEN', 'Not permitted.'); if (!d.reason || !d.evidence) return fail('REASON', 'Reason and evidence reference are required.');
    if (!Number.isInteger(d.amount) || d.amount === 0 || Math.abs(d.amount) > this.LIMIT) return fail('LIMIT', `Adjustment must be non-zero and within ±${fmt(this.LIMIT)}.`);
    const r = { id: rid('AJ'), uid: d.uid, amount: d.amount, reason: d.reason, evidence: d.evidence, by: actor.id, byName: actor.name, status: 'PENDING', ts: now() }; DB.add('adjustments', r); Audit.log({ actor: actor.id, role: actor.role, action: 'adjust.request', target: r.id, after: r }); return okr();
  },
  decide(actor, id, ok) {
    if (!Auth.can(actor, 'adjust.approve')) return fail('FORBIDDEN', 'Not permitted.'); const r = DB.byId('adjustments', id); if (!r || r.status !== 'PENDING') return fail('STATE', 'Not pending.');
    if (r.by === actor.id) return fail('DUAL', 'Separation of duties: you cannot approve your own request.');
    if (ok) { if (r.amount < 0 && Acct.balances(r.uid).available < -r.amount) return fail('FUNDS', 'Debit exceeds available balance.'); Ledger.post('adj:' + id, 'ADJUSTMENT', [{ acct: 'u:' + r.uid + ':avail', dir: r.amount > 0 ? 'C' : 'D', amt: Math.abs(r.amount) }, { acct: 'p:adjust', dir: r.amount > 0 ? 'D' : 'C', amt: Math.abs(r.amount) }], { adj: id }); Notify.push(r.uid, 'payment', 'Account adjustment', `An adjustment of ${fmt(r.amount)} was applied. Reason: ${r.reason}`); }
    DB.upd('adjustments', id, { status: ok ? 'APPROVED' : 'DECLINED', approver: actor.id }); Audit.log({ actor: actor.id, role: actor.role, action: 'adjust.' + (ok ? 'approve' : 'decline'), target: id }); return okr();
  }
};

/* ---------- support ---------- */
const Support = {
  create(uid, d) { const t = { id: rid('TK'), uid, name: d.name, email: d.email, category: d.category, subject: d.subject, status: 'OPEN', ref: d.ref || '', created: now(), updated: now(), msgs: [{ from: 'customer', text: d.text, ts: now() }] }; DB.add('tickets', t); if (uid) Notify.push(uid, 'support', 'Ticket created', `Ticket ${t.id} was opened.`, '#/app/support/' + t.id); return okr({ id: t.id }); },
  reply(id, from, text, actor) { const t = DB.byId('tickets', id); if (!t) return fail('NF', 'No ticket'); DB.upd('tickets', id, { msgs: [...t.msgs, { from, text, ts: now(), by: actor?.name }], status: from === 'customer' ? 'IN_PROGRESS' : 'WAITING_FOR_CUSTOMER', updated: now() }); if (from === 'agent' && t.uid) Notify.push(t.uid, 'support', 'Support replied', `New reply on ticket ${id}.`, '#/app/support/' + id); return okr(); }
};

/* ---------- DEMO trading simulator (orders, positions, margin) ---------- */
const Trade = {
  openPos: uid => DB.get('positions').filter(p => p.uid === uid && p.status === 'OPEN'),
  notional: (sym, units) => units * Market.toUSD(Market.meta[sym].base),
  marginOf: (sym, units, lev) => Math.round(Trade.notional(sym, units) / lev * 100),
  marginUsed: uid => Trade.openPos(uid).reduce((a, p) => a + p.margin, 0),
  pnl(p, px) { const m = Market.meta[p.sym]; const d = p.side === 'buy' ? px - p.entry : p.entry - px; return Math.round(d * p.units * Market.toUSD(m.quote) * 100); },
  px(p) { const q = Market.quote(p.sym); return p.side === 'buy' ? q.bid : q.ask; }, // close at the opposite side
  floating: uid => Trade.openPos(uid).reduce((a, p) => a + Trade.pnl(p, Trade.px(p)), 0),
  account(uid) { const u = Auth.user(uid), bal = Acct.balances(uid).available, fl = Trade.floating(uid), mu = Trade.marginUsed(uid), eq = bal + fl; return { balance: bal, equity: eq, margin: mu, free: eq - mu, level: mu ? eq / mu * 100 : null, floating: fl, lev: Math.min(u.prefs.lev || 30, CFG.maxLeverage) }; },
  place(uid, o) { // o:{sym,side,type,lots,price,sl,tp}
    const u = Auth.user(uid); const g = guardMoney(u); if (g) return g; if (!Settings.get().flags.demoTrading) return fail('OFF', 'Demo trading is disabled.');
    if (!Acct.caps(u).trade) return fail('DENIED', Acct.why(u, 'trade')); const m = Market.meta[o.sym]; if (!m) return fail('SYM', 'Unknown instrument.');
    const lots = +o.lots; if (!(lots >= CFG.minLots && lots <= CFG.maxLots)) return fail('SIZE', `Size must be ${CFG.minLots}–${CFG.maxLots} lots.`);
    if (Math.abs(Math.round(lots / CFG.lotStep) * CFG.lotStep - lots) > 1e-9) return fail('SIZE', `Size must be a multiple of ${CFG.lotStep} lots.`);
    const units = Math.round(lots * CFG.lot), q = Market.quote(o.sym); if (Market.stale()) return fail('STALE', 'Price data is stale. Orders are blocked until quotes refresh.');
    const acc = this.account(uid), margin = this.marginOf(o.sym, units, acc.lev); if (margin > acc.free) return fail('MARGIN', `Insufficient free margin. Required ${fmt(margin)}, available ${fmt(Math.max(0, acc.free))}.`);
    const sl = o.sl ? +o.sl : null, tp = o.tp ? +o.tp : null, side = o.side, ref = o.type === 'market' ? (side === 'buy' ? q.ask : q.bid) : +o.price;
    if (o.type !== 'market' && !(ref > 0)) return fail('PRICE', 'Enter a valid price.');
    if (sl && (side === 'buy' ? sl >= ref : sl <= ref)) return fail('SL', 'Stop-loss is on the wrong side of the price.'); if (tp && (side === 'buy' ? tp <= ref : tp >= ref)) return fail('TP', 'Take-profit is on the wrong side of the price.');
    const ord = { id: rid('OR'), uid, sym: o.sym, side, type: o.type, units, lots, price: o.type === 'market' ? null : ref, sl, tp, status: 'PENDING', created: now(), demo: true };
    if (o.type !== 'market') {
      const bad = o.type === 'limit' ? (side === 'buy' ? ref >= q.ask : ref <= q.bid) : (side === 'buy' ? ref <= q.ask : ref >= q.bid);
      if (bad) return fail('PRICE', 'Price is on the wrong side of the market for this order type.');
    }
    DB.add('orders', ord);
    if (o.type === 'market') this.fill(ord.id, ref);
    Audit.log({ actor: uid, role: 'customer', action: 'demo.order', target: ord.id }); return okr({ id: ord.id });
  },
  fill(orderId, price) {
    const o = DB.byId('orders', orderId); if (!o || o.status !== 'PENDING') return; const lev = this.account(o.uid).lev;
    DB.add('positions', { id: rid('PS'), uid: o.uid, sym: o.sym, side: o.side, units: o.units, entry: price, sl: o.sl, tp: o.tp, margin: this.marginOf(o.sym, o.units, lev), opened: now(), status: 'OPEN', orderId });
    DB.upd('orders', orderId, { status: 'FILLED', fillPrice: price, filled: now() }); Notify.push(o.uid, 'trade', 'Demo order filled (simulated)', `${o.side.toUpperCase()} ${o.lots} ${o.sym} @ ${Market.fmt(o.sym, price)}`);
  },
  close(posId, reason = 'manual') {
    const p = DB.byId('positions', posId); if (!p || p.status !== 'OPEN') return; const px = reason === 'sl' ? p.sl : reason === 'tp' ? p.tp : this.px(p), pnl = this.pnl(p, px);
    if (pnl) Ledger.post('pnl:' + posId, 'DEMO_PNL', pnl > 0 ? [{ acct: 'p:demo_pnl', dir: 'D', amt: pnl }, { acct: 'u:' + p.uid + ':avail', dir: 'C', amt: pnl }] : [{ acct: 'u:' + p.uid + ':avail', dir: 'D', amt: -pnl }, { acct: 'p:demo_pnl', dir: 'C', amt: -pnl }], { pos: posId });
    DB.upd('positions', posId, { status: 'CLOSED', exit: px, pnl, closed: now(), closeReason: reason }); return pnl;
  },
  cancel(uid, id) { const o = DB.byId('orders', id); if (!o || o.uid !== uid || o.status !== 'PENDING') return fail('STATE', 'Order cannot be cancelled.'); DB.upd('orders', id, { status: 'CANCELLED' }); return okr(); },
  modify(uid, id, sl, tp) { const p = DB.byId('positions', id); if (!p || p.uid !== uid || p.status !== 'OPEN') return fail('STATE', 'Position is not open.'); const px = this.px(p); sl = sl ? +sl : null; tp = tp ? +tp : null; if (sl && (p.side === 'buy' ? sl >= px : sl <= px)) return fail('SL', 'Stop-loss is on the wrong side.'); if (tp && (p.side === 'buy' ? tp <= px : tp >= px)) return fail('TP', 'Take-profit is on the wrong side.'); DB.upd('positions', id, { sl, tp }); return okr(); },
  /* runs on each simulated tick while the app is open (browser-only simulation) */
  engine() {
    DB.get('orders').filter(o => o.status === 'PENDING').forEach(o => { const q = Market.quote(o.sym); const hit = o.type === 'limit' ? (o.side === 'buy' ? q.ask <= o.price : q.bid >= o.price) : (o.side === 'buy' ? q.ask >= o.price : q.bid <= o.price); if (hit) this.fill(o.id, o.side === 'buy' ? q.ask : q.bid); });
    DB.get('positions').filter(p => p.status === 'OPEN').forEach(p => { const px = this.px(p); if (p.sl && (p.side === 'buy' ? px <= p.sl : px >= p.sl)) this.close(p.id, 'sl'); else if (p.tp && (p.side === 'buy' ? px >= p.tp : px <= p.tp)) this.close(p.id, 'tp'); });
    const seen = new Set(); DB.get('positions').filter(p => p.status === 'OPEN').forEach(p => { if (seen.has(p.uid)) return; seen.add(p.uid); const a = this.account(p.uid); if (a.level !== null && a.level < 50) { const worst = this.openPos(p.uid).sort((x, y) => this.pnl(x, this.px(x)) - this.pnl(y, this.px(y)))[0]; this.close(worst.id, 'stopout'); Notify.push(p.uid, 'margin', 'Margin stop-out (simulated)', 'A demo position was closed because margin level fell below 50%.'); } });
    DB.get('alerts').filter(a => !a.fired).forEach(a => { const m = Market.mid(a.sym); if (a.dir === 'above' ? m >= a.price : m <= a.price) { DB.upd('alerts', a.id, { fired: true }); Notify.push(a.uid, 'alert', 'Price alert (simulated feed)', `${a.sym} crossed ${a.price}.`); } });
  }
};
