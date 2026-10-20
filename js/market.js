/* SIMULATED market data. These prices are random-walk values, NOT a real market feed and NOT executable.
   Replace with a licensed data vendor (WebSocket) in production; see docs/ARCHITECTURE.md. */
const Market = (() => {
  const raw = `EURUSD 1.0850|GBPUSD 1.2700|AUDUSD 0.6600|NZDUSD 0.6100|USDJPY 150.20|USDCAD 1.3600|USDCHF 0.8850|EURGBP 0.8540|EURJPY 163.00|EURCHF 0.9600|EURAUD 1.6440|EURCAD 1.4760|EURNZD 1.7790|GBPJPY 190.80|GBPCHF 1.1240|GBPAUD 1.9250|GBPCAD 1.7270|GBPNZD 2.0820|AUDJPY 99.10|AUDCHF 0.5840|AUDCAD 0.8980|AUDNZD 1.0820|NZDJPY 91.60|NZDCHF 0.5400|NZDCAD 0.8300|CADJPY 110.40|CADCHF 0.6510|CHFJPY 169.70`;
  const TF = { M1: 15, M5: 30, M15: 45, H1: 60, H4: 80, D1: 100 }; // accelerated: ticks per candle
  const TFVOL = { M1: 1, M5: 2.2, M15: 3.9, H1: 7.7, H4: 15, D1: 38 };
  const list = [], meta = {}, mid = {}, open = {}, cache = {}, subs = [];
  let lastTick = Date.now(), timer = null;

  raw.split('|').forEach(x => {
    const [s, p] = x.trim().split(' ');
    const jpy = s.endsWith('JPY');
    meta[s] = { s, base: s.slice(0, 3), quote: s.slice(3), digits: jpy ? 3 : 5, pip: jpy ? 0.01 : 0.0001,
      spreadPips: /USD$|^USD/.test(s) && /^(EURUSD|USDJPY|GBPUSD|USDCHF|USDCAD)$/.test(s) ? 1.2 : (/AUD|NZD|CHF/.test(s) ? 2.2 : 1.8),
      vol: jpy ? 1.1e-4 : 1.3e-4, cat: /USD/.test(s) ? 'Majors' : 'Crosses' };
    mid[s] = open[s] = +p; list.push(s);
  });

  const rnd = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
  const halfSpread = s => meta[s].spreadPips * meta[s].pip / 2;
  const quote = s => ({ sym: s, bid: mid[s] - halfSpread(s), ask: mid[s] + halfSpread(s), mid: mid[s], ts: lastTick, chg: (mid[s] / open[s] - 1) * 100 });

  function candles(s, tf = 'M5') {
    const k = s + '|' + tf;
    if (!cache[k]) { // generate history backwards from the current price so the chart ends at "now"
      const arr = []; let c = mid[s];
      for (let i = 0; i < 160; i++) {
        const v = meta[s].vol * TFVOL[tf] * c * 0.35; let o = c; let h = Math.max(o, c), l = Math.min(o, c);
        for (let j = 0; j < 4; j++) { o += rnd() * v; h = Math.max(h, o); l = Math.min(l, o); }
        h += Math.abs(rnd()) * v * 0.3; l -= Math.abs(rnd()) * v * 0.3;
        arr.unshift({ o, h: Math.max(h, o, c), l: Math.min(l, o, c), c, n: TF[tf] }); c = o;
      }
      arr[arr.length - 1].n = 0; arr[arr.length - 1].c = mid[s];
      cache[k] = arr;
    }
    return cache[k];
  }

  function tick() {
    lastTick = Date.now();
    list.forEach(s => {
      mid[s] += rnd() * meta[s].vol * mid[s];
      Object.keys(TF).forEach(tf => {
        const arr = cache[s + '|' + tf]; if (!arr) return;
        let c = arr[arr.length - 1];
        c.c = mid[s]; c.h = Math.max(c.h, mid[s]); c.l = Math.min(c.l, mid[s]); c.n++;
        if (c.n >= TF[tf]) arr.push({ o: mid[s], h: mid[s], l: mid[s], c: mid[s], n: 0 }), arr.length > 400 && arr.shift();
      });
    });
    subs.forEach(f => { try { f(); } catch (e) { console.error(e); } });
  }
  function start() { if (!timer) timer = setInterval(tick, 1000); }
  const stale = () => Date.now() - lastTick > (window.AURA_CONFIG.staleQuoteMs || 5000);
  /* Convert 1 unit of currency `c` to USD using simulated mids (for margin / P&L display only). */
  function toUSD(c) {
    if (c === 'USD') return 1;
    if (mid[c + 'USD']) return mid[c + 'USD'];
    if (mid['USD' + c]) return 1 / mid['USD' + c];
    const via = list.find(p => p.startsWith(c) && mid[p.slice(3) + 'USD']); // e.g. EUR -> EURGBP * GBPUSD
    return via ? mid[via] * toUSD(via.slice(3)) : 1;
  }
  return { list, meta, quote, candles, TF: Object.keys(TF), start, stale, toUSD, onTick: f => { subs.push(f); return () => subs.splice(subs.indexOf(f), 1); },
    fmt: (s, p) => p.toFixed(meta[s].digits), mid: s => mid[s] };
})();
