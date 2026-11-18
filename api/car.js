// GET  /api/car?t=CODICE  → portafoglio dell'utente collegato, per l'app Android Auto
// POST /api/car            → (dalla web app, con la sessione) crea o rinnova il codice di collegamento
import { randomBytes } from 'node:crypto';
import { supa, serviceKeyProblem } from './_lib/run.js';
import { userIdFromToken, portfolioFor } from './_lib/portfolio.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const s = supa();
  const problem = serviceKeyProblem(s.service);
  if (!s.url || problem) return res.status(500).json({ error: problem || 'Manca SUPABASE_URL' });
  try {
    if (req.method === 'POST') {
      const jwt = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const u = await fetch(`${s.url}/auth/v1/user`, { headers: { apikey: s.anon, Authorization: `Bearer ${jwt}` } });
      if (!u.ok) return res.status(401).json({ error: 'Sessione non valida: accedi di nuovo' });
      const user = await u.json();
      const token = randomBytes(24).toString('base64url');
      const r = await fetch(`${s.url}/rest/v1/car_tokens?on_conflict=user_id`, {
        method: 'POST',
        headers: { ...s.headers(s.service), Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ user_id: user.id, token, created_at: new Date().toISOString() })
      });
      if (!r.ok) throw new Error(`Salvataggio codice non riuscito (${r.status}): ${await r.text()}`);
      return res.status(200).json({ token });
    }
    const token = String(req.query.t || req.headers['x-car-token'] || '');
    const userId = await userIdFromToken(token);
    if (!userId) return res.status(401).json({ error: 'Codice di collegamento non valido: rigeneralo dalla web app' });
    res.status(200).json(await portfolioFor(userId));
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}
