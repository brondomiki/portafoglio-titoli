// Analisi programmata: calcola indicatori e livelli per l'universo + i titoli posseduti/osservati
// e salva un'istantanea su Supabase (tabella analysis_runs).
import { getChart } from './yahoo.js';
import { indicators, technicalScore, entryPlan, UNIVERSE } from '../../public/analysis.js';

export function supa() {
  const env = process.env;
  let url = (env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || '').trim();
  try { if (url) url = new URL(url.startsWith('http') ? url : `https://${url}`).origin; } catch { url = ''; }
  const anon = (env.SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY || env.SUPABASE_PUBLISHABLE_KEY || env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || '').trim();
  const service = (env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY || '').trim();
  const headers = (key) => ({ apikey: key, ...(key.startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json' });
  return { url, anon, service, headers };
}

export async function latestRuns(limit = 2) {
  const s = supa();
  const key = s.service || s.anon;
  if (!s.url || !key) return [];
  const r = await fetch(`${s.url}/rest/v1/analysis_runs?select=id,run_at,slot,data&order=run_at.desc&limit=${limit}`, { headers: s.headers(key) });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return r.json();
}

const romeHour = (d = new Date()) => +new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', hourCycle: 'h23' }).format(d);

export async function runAnalysis({ slot } = {}) {
  const s = supa();
  if (!s.url || !s.service) throw new Error('Manca la variabile SUPABASE_SERVICE_ROLE_KEY su Vercel');
  const H = s.headers(s.service);

  // evita doppioni ravvicinati (es. cron + pulsante)
  const last = (await latestRuns(1))[0];
  if (last && Date.now() - new Date(last.run_at) < 10 * 60 * 1000) return { skipped: true, run: last };

  // titoli posseduti e osservati da tutti gli utenti (solo i simboli)
  const own = new Set();
  for (const t of ['transactions', 'watchlist']) {
    const r = await fetch(`${s.url}/rest/v1/${t}?select=symbol`, { headers: H });
    if (r.ok) for (const x of await r.json()) own.add(x.symbol);
  }
  const symbols = [...new Set([...UNIVERSE, ...own])];

  const syms = {};
  const errors = {};
  for (let i = 0; i < symbols.length; i += 10) {
    const batch = symbols.slice(i, i + 10);
    const res = await Promise.allSettled(batch.map((x) => getChart(x, '1y')));
    res.forEach((r, j) => {
      const sym = batch[j];
      if (r.status !== 'fulfilled') { errors[sym] = String(r.reason?.message || r.reason); return; }
      const q = r.value;
      if (!q.history || q.history.length < 60) { errors[sym] = 'storico insufficiente'; return; }
      const ind = indicators(q.history, q.price);
      const { score } = technicalScore(ind);
      syms[sym] = { name: q.name, currency: q.currency, price: q.price, score: +score.toFixed(2), ind };
    });
  }

  const ranked = UNIVERSE.filter((x) => syms[x])
    .map((x) => ({ x, plan: entryPlan(syms[x].ind) }))
    .sort((a, b) => b.plan.score - a.plan.score || a.plan.dist - b.plan.dist)
    .slice(0, 25)
    .map((r) => r.x);

  const label = slot || (romeHour() < 12 ? 'mattina' : 'pomeriggio');
  const data = { syms, ranked, errors, universe: UNIVERSE.length };
  const ins = await fetch(`${s.url}/rest/v1/analysis_runs`, {
    method: 'POST',
    headers: { ...H, Prefer: 'return=representation' },
    body: JSON.stringify({ slot: label, data })
  });
  if (!ins.ok) throw new Error(`Salvataggio non riuscito (${ins.status}): ${await ins.text()}`);
  const [run] = await ins.json();

  // conserva solo gli ultimi 60 giorni
  const cutoff = new Date(Date.now() - 60 * 864e5).toISOString();
  await fetch(`${s.url}/rest/v1/analysis_runs?run_at=lt.${cutoff}`, { method: 'DELETE', headers: H }).catch(() => {});

  return { skipped: false, run: { id: run.id, run_at: run.run_at, slot: run.slot }, analyzed: Object.keys(syms).length, errors };
}
