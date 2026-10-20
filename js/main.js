/* Boot: start simulated market, wire tick -> trading engine + live page hooks, session idle monitor, router. */
'use strict';
(function () {
  Market.start();
  Market.onTick(() => { if (Auth.me()) Trade.engine(); Live.hooks.forEach(h => { try { h(); } catch (e) { console.error(e); } }); });
  ['click', 'keydown'].forEach(ev => document.addEventListener(ev, () => { Sess.touch('customer'); Sess.touch('admin'); }, { passive: true }));
  let warned = {};
  setInterval(() => {
    ['customer', 'admin'].forEach(k => {
      const had = sessionStorage.getItem('aura_' + k); if (!had) return;
      const left = Sess.idleLeft(k);
      if (!left) { sessionStorage.removeItem('aura_' + k); warned[k] = false; toast('Your session expired. Please sign in again.', 'err'); Router.go(k === 'admin' ? '/admin/login' : '/login?expired=1'); }
      else if (left < 120000 && !warned[k]) { warned[k] = true; toast('Your session will expire in under 2 minutes. Click anywhere to stay signed in.', 'info'); }
      else if (left > 130000) warned[k] = false;
    });
  }, 20000);
  window.addEventListener('offline', () => toast('You are offline. Changes will not be saved until you reconnect.', 'err'));
  window.addEventListener('error', e => console.error(e.error || e.message));
  Shell.theme();
  Router.run();
})();
