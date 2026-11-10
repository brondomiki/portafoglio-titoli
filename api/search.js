// GET /api/search?q=eni  -> elenco di titoli/ETF corrispondenti (fonte: Yahoo Finance)
export default async function handler(req, res) {
  const q = String(req.query.q || '').trim();
  if (q.length < 1) return res.status(200).json({ results: [] });
  try {
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(
      q
    )}&quotesCount=10&newsCount=0&lang=it-IT&region=IT`;
    const r = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36'
      }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const results = (j.quotes || [])
      .filter((x) => x.symbol && ['EQUITY', 'ETF', 'MUTUALFUND', 'INDEX', 'CRYPTOCURRENCY'].includes(x.quoteType))
      .map((x) => ({
        symbol: x.symbol,
        name: x.longname || x.shortname || x.symbol,
        exchange: x.exchDisp || x.exchange || '',
        type: x.typeDisp || x.quoteType
      }));
    res.setHeader('Cache-Control', 's-maxage=3600');
    res.status(200).json({ results });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e), results: [] });
  }
}
