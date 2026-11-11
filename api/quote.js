// GET /api/quote?symbols=AAPL,ENI.MI&range=1y
// Restituisce prezzo attuale, storico giornaliero e tassi di cambio verso EUR (fonte: Yahoo Finance).
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36',
  Accept: 'application/json'
};
const RANGES = new Set(['5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'max']);

async function getChart(symbol, range = '1y', interval = '1d') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?range=${range}&interval=${interval}&includePrePost=false&events=div,split`;
  let r = await fetch(url, { headers: HEADERS });
  if (!r.ok) r = await fetch(url.replace('query1', 'query2'), { headers: HEADERS });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error(j?.chart?.error?.description || 'Simbolo non trovato');
  const m = res.meta || {};
  const ts = res.timestamp || [];
  const closes = res.indicators?.quote?.[0]?.close || [];
  const history = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (c != null && isFinite(c)) history.push([ts[i] * 1000, +c.toFixed(4)]);
  }
  const price = m.regularMarketPrice ?? history.at(-1)?.[1] ?? null;
  // chiusura precedente: penultima barra se l'ultima è la seduta corrente
  let prevClose = m.previousClose ?? null;
  if (prevClose == null && history.length > 1) {
    const lastDay = new Date(history.at(-1)[0]).toDateString();
    const mktDay = m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toDateString() : lastDay;
    prevClose = lastDay === mktDay ? history.at(-2)[1] : history.at(-1)[1];
  }
  return {
    symbol: m.symbol || symbol,
    name: m.longName || m.shortName || symbol,
    currency: m.currency || 'EUR',
    exchange: m.fullExchangeName || m.exchangeName || '',
    price,
    prevClose,
    time: m.regularMarketTime ? m.regularMarketTime * 1000 : Date.now(),
    history
  };
}


// Pre-market / after-hours (solo titoli USA): ultimo prezzo fuori dall'orario regolare (9:30–16:00 ora di New York)
const etMinutes = (ms) => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const h = +parts.find((x) => x.type === 'hour').value, m = +parts.find((x) => x.type === 'minute').value;
  return h * 60 + m;
};
const isUS = (q) => q.currency === 'USD' && !q.symbol.includes('.') && !q.symbol.includes('=') && !q.symbol.startsWith('^');

async function getExtended(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m&includePrePost=true`;
  let r = await fetch(url, { headers: HEADERS });
  if (!r.ok) r = await fetch(url.replace('query1', 'query2'), { headers: HEADERS });
  if (!r.ok) return null;
  const res = (await r.json())?.chart?.result?.[0];
  if (!res) return null;
  const m = res.meta || {};
  const ts = res.timestamp || [];
  const cl = res.indicators?.quote?.[0]?.close || [];
  let i = ts.length - 1;
  while (i >= 0 && (cl[i] == null || !isFinite(cl[i]))) i--;
  if (i < 0) return null;
  const t = ts[i] * 1000;
  const mins = etMinutes(t);
  const regular = mins >= 570 && mins < 960;
  if (regular || t <= (m.regularMarketTime || 0) * 1000) return null;
  const base = m.regularMarketPrice;
  const price = +cl[i].toFixed(4);
  return {
    type: mins < 570 ? 'pre' : 'post',
    price,
    change: base ? price - base : null,
    changePct: base ? (price / base - 1) * 100 : null,
    time: t
  };
}

function baseCurrency(cur) {
  if (!cur) return { cur: 'EUR', div: 1 };
  if (cur === 'GBp' || cur === 'GBX') return { cur: 'GBP', div: 100 };
  if (cur === 'ILA') return { cur: 'ILS', div: 100 };
  if (cur === 'ZAc') return { cur: 'ZAR', div: 100 };
  return { cur: cur.toUpperCase(), div: 1 };
}

export default async function handler(req, res) {
  try {
    const raw = String(req.query.symbols || '').trim();
    const range = RANGES.has(req.query.range) ? req.query.range : '1y';
    const symbols = [...new Set(raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))].slice(0, 60);
    if (!symbols.length) return res.status(400).json({ error: 'Parametro symbols mancante' });

    const results = await Promise.allSettled(symbols.map((s) => getChart(s, range)));
    const quotes = {};
    const errors = {};
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') quotes[symbols[i]] = r.value;
      else errors[symbols[i]] = String(r.reason?.message || r.reason);
    });

    // prezzi pre-market / after-hours per i titoli USA
    await Promise.all(
      Object.values(quotes).filter(isUS).map(async (q) => {
        try { q.ext = await getExtended(q.symbol); } catch { q.ext = null; }
      })
    );

    // tassi di cambio -> EUR (valore di 1 unità della valuta di quotazione in euro)
    const curs = new Set(Object.values(quotes).map((q) => baseCurrency(q.currency).cur));
    curs.delete('EUR');
    const fx = { EUR: 1 };
    await Promise.all(
      [...curs].map(async (c) => {
        try {
          const q = await getChart(`${c}EUR=X`, '5d');
          fx[c] = q.price;
        } catch {
          fx[c] = null;
        }
      })
    );
    for (const q of Object.values(quotes)) {
      const b = baseCurrency(q.currency);
      q.fxToEur = fx[b.cur] != null ? fx[b.cur] / b.div : null;
    }

    res.setHeader('Cache-Control', req.query.live ? 'no-store' : 's-maxage=120, stale-while-revalidate=600');
    res.status(200).json({ quotes, errors, fx, updated: Date.now() });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}
