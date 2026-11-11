// GET  /api/analysis  → ultime due analisi programmate (per confrontare i cambiamenti)
// POST /api/analysis  → esegue subito una nuova analisi (serve essere connessi all'app)
import { latestRuns, runAnalysis, supa } from './_lib/run.js';

export default async function handler(req, res) {
  try {
    if (req.method === 'POST') {
      const s = supa();
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!token || !s.url || !s.anon) return res.status(401).json({ error: 'Accesso richiesto' });
      const u = await fetch(`${s.url}/auth/v1/user`, { headers: { apikey: s.anon, Authorization: `Bearer ${token}` } });
      if (!u.ok) return res.status(401).json({ error: 'Sessione non valida' });
      const out = await runAnalysis({ slot: 'manuale' });
      return res.status(200).json(out);
    }
    const runs = await latestRuns(2);
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.status(200).json({ runs });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e), runs: [] });
  }
}
