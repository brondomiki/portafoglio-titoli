// Chiamata da Vercel Cron (vedi vercel.json): mattina e pomeriggio nei giorni di borsa.
import { runAnalysis } from './_lib/run.js';

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const auth = String(req.headers.authorization || '');
  const ua = String(req.headers['user-agent'] || '');
  const allowed = secret ? auth === `Bearer ${secret}` : ua.includes('vercel-cron');
  if (!allowed) return res.status(401).json({ error: 'Non autorizzato' });
  try {
    res.status(200).json(await runAnalysis());
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}
