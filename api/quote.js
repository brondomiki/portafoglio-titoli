// GET /api/quote?symbols=AAPL,ENI.MI&range=1y
// Restituisce prezzo attuale, storico giornaliero e tassi di cambio verso EUR (fonte: Yahoo Finance).
import { getChart, getExtended, baseCurrency, isUS, RANGES } from './_lib/yahoo.js';

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
