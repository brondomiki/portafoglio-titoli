// Portafoglio di un utente calcolato sul server (usato dall'app Android Auto).
import { getChart, getExtended, baseCurrency, isUS } from './yahoo.js';
import { supa, latestRuns } from './run.js';
import { indicators, evaluatePosition, entryPlan, livePlan } from '../../public/analysis.js';
import { sayable } from '../../public/speech.js';

const nf = (d) => new Intl.NumberFormat('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d });
const eur = (v) => (v == null || !isFinite(v) ? '—' : `${nf(2).format(v)} €`);
const sEur = (v) => (v == null || !isFinite(v) ? '—' : `${v >= 0 ? '+' : '−'}${nf(2).format(Math.abs(v))} €`);
const pct = (v) => (v == null || !isFinite(v) ? '—' : `${v >= 0 ? '+' : '−'}${nf(2).format(Math.abs(v))}%`);
const pctShort = (v) => (v == null || !isFinite(v) ? '' : `${v >= 0 ? '+' : '-'}${nf(1).format(Math.abs(v))}%`);
const price = (v, cur) => (v == null ? '—' : `${nf(v < 2 ? 4 : 2).format(v)} ${cur === 'EUR' ? '€' : cur === 'USD' ? '$' : cur || ''}`.trim());
const spokenName = (n, sym) => String(n || sym).replace(/\b(Inc|Corp|Corporation|S\.p\.A|SpA|N\.V|AG|SE|plc|Ltd|Holdings?|Class [AB])\b\.?/gi, '').replace(/[,.]\s*$/, '').replace(/\s+/g, ' ').trim();
const EXT = { pre: 'Pre-market', post: 'After-hours' };

export async function userIdFromToken(token) {
  const s = supa();
  if (!token || token.length < 20) return null;
  const r = await fetch(`${s.url}/rest/v1/car_tokens?select=user_id&token=eq.${encodeURIComponent(token)}`, { headers: s.headers(s.service) });
  if (!r.ok) throw new Error(`Supabase ${r.status}`);
  return (await r.json())[0]?.user_id || null;
}

function applyTx(h, t) {
  const q = +t.quantity, p = +t.price, f = +t.fees || 0;
  if (t.side === 'buy') { h.qty += q; h.cost += q * p + f; }
  else {
    const avg = h.qty > 0 ? h.cost / h.qty : 0;
    const sold = Math.min(q, h.qty);
    h.cost -= avg * sold; h.qty -= sold;
    if (h.qty < 1e-9) { h.qty = 0; h.cost = 0; }
  }
}

async function fxMap(currencies) {
  const fx = { EUR: 1 };
  await Promise.all([...currencies].filter((c) => c !== 'EUR').map(async (c) => {
    try { fx[c] = (await getChart(`${c}EUR=X`, '5d')).price; } catch { fx[c] = null; }
  }));
  return fx;
}

export async function portfolioFor(userId) {
  const s = supa();
  const H = s.headers(s.service);
  const [txR, wlR] = await Promise.all([
    fetch(`${s.url}/rest/v1/transactions?select=*&user_id=eq.${userId}&order=trade_date.asc,created_at.asc`, { headers: H }),
    fetch(`${s.url}/rest/v1/watchlist?select=symbol,name,target_price&user_id=eq.${userId}`, { headers: H })
  ]);
  if (!txR.ok) throw new Error(`Supabase ${txR.status}`);
  const tx = await txR.json();
  const watch = wlR.ok ? await wlR.json() : [];

  const hold = {};
  for (const t of tx) applyTx((hold[t.symbol] ||= { symbol: t.symbol, name: t.name || t.symbol, qty: 0, cost: 0 }), t);
  const held = Object.values(hold).filter((h) => h.qty > 0);

  const runs = await latestRuns(2).catch(() => []);
  const snap = (x) => runs[0]?.data?.syms?.[x] || null;
  const prevSnap = (x) => runs[1]?.data?.syms?.[x] || null;

  const quotes = {};
  await Promise.all(held.map(async (h) => {
    try {
      const q = await getChart(h.symbol, snap(h.symbol) ? '5d' : '1y');
      if (isUS(q)) q.ext = await getExtended(h.symbol).catch(() => null);
      quotes[h.symbol] = q;
    } catch {}
  }));
  const fx = await fxMap(new Set(Object.values(quotes).map((q) => baseCurrency(q.currency).cur)));

  const items = [];
  let value = 0, cost = 0, day = 0, prev = 0;
  for (const h of held) {
    const q = quotes[h.symbol];
    if (!q) continue;
    const b = baseCurrency(q.currency);
    const k = fx[b.cur] != null ? fx[b.cur] / b.div : null;
    if (k == null) continue;
    const valueEur = h.qty * q.price * k;
    const costEur = h.cost * k;
    const dayEur = q.prevClose ? h.qty * (q.price - q.prevClose) * k : 0;
    const dayPct = q.prevClose ? (q.price / q.prevClose - 1) * 100 : null;
    value += valueEur; cost += costEur; day += dayEur; prev += valueEur - dayEur;
    const sn = snap(h.symbol), pv = prevSnap(h.symbol);
    const ind = sn ? sn.ind : q.history?.length > 60 ? indicators(q.history, q.price) : null;
    const ev = ind ? evaluatePosition(ind, { value: valueEur, cost: costEur }) : null;
    const prevAction = pv && ev ? evaluatePosition(pv.ind, { value: valueEur, cost: costEur }).action : null;
    const ext = q.ext ? { type: q.ext.type, label: EXT[q.ext.type], price: q.ext.price, changePct: q.ext.changePct } : null;
    const name = spokenName(q.name || h.name, h.symbol);
    const plEur = valueEur - costEur, plPct = costEur ? (valueEur / costEur - 1) * 100 : 0;
    const speech = [
      `${name}: oggi ${sEur(dayEur)}, ${pctShort(dayPct)}.`,
      ext ? `${ext.label} ${pctShort(ext.changePct)}.` : '',
      `Dall'acquisto ${sEur(plEur)}, ${pctShort(plPct)}. Valore ${eur(valueEur)}.`,
      ev ? `Valutazione: ${ev.action}.${prevAction && prevAction !== ev.action ? ` Prima era ${prevAction}.` : ''} ${ev.detail}` : ''
    ].filter(Boolean).map(sayable).join(' ');
    items.push({
      symbol: h.symbol, name, currency: q.currency, qty: h.qty, price: q.price,
      dayEur, dayPct, valueEur, plEur, plPct, action: ev?.action || null, tone: ev?.tone || null, prevAction, ext,
      title: `${h.symbol}  ${sEur(dayEur)}  (${pct(dayPct)})`,
      subtitle: `${ev ? ev.action + ' · ' : ''}Totale ${pct(plPct)}${ext ? ` · ${ext.label} ${pctShort(ext.changePct)}` : ''}`,
      speech
    });
  }
  items.sort((a, b) => Math.abs(b.dayEur) - Math.abs(a.dayEur));

  const totals = { value, cost, pl: value - cost, plPct: cost ? (value / cost - 1) * 100 : 0, day, dayPct: prev ? (day / prev) * 100 : 0 };
  const changed = items.filter((i) => i.prevAction && i.prevAction !== i.action);
  const run = runs[0];
  const runLabel = run ? `Analisi ${({ mattina: 'del mattino', pomeriggio: 'del pomeriggio', manuale: 'manuale' })[run.slot] || ''} delle ${new Date(run.run_at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' })}` : '';
  const summary = {
    title: `Oggi ${sEur(day)} (${pct(totals.dayPct)})`,
    subtitle: `Valore ${eur(value)} · Totale ${sEur(totals.pl)}`,
    speech: [
      `Portafoglio oggi ${sEur(day)}, ${pctShort(totals.dayPct)}.`,
      `Valore totale ${eur(value)}, dall'acquisto ${sEur(totals.pl)}.`,
      changed.length ? `Valutazioni cambiate: ${changed.map((i) => `${i.name}, ora ${i.action}`).join('; ')}.` : '',
      items.length ? `Oggi si è mosso di più ${items[0].name}, ${sEur(items[0].dayEur)}.` : 'Non hai titoli in portafoglio.'
    ].filter(Boolean).map(sayable).join(' ')
  };

  // suggeriti dall'ultima analisi programmata (esclusi titoli posseduti e osservati)
  const exclude = new Set([...held.map((h) => h.symbol), ...watch.map((w) => w.symbol)]);
  const suggestions = (run?.data?.ranked || []).filter((x) => !exclude.has(x)).slice(0, 8).map((x) => {
    const sn = snap(x);
    const plan = livePlan(entryPlan(sn.ind), sn.price);
    const name = spokenName(sn.name, x);
    return {
      symbol: x, name,
      title: `${x}  ${plan.status.label}`,
      subtitle: `Ingresso ≤ ${price(plan.entry, sn.currency)} · ora ${price(sn.price, sn.currency)}`,
      speech: sayable(`${name}: ${plan.status.label}. Prezzo ${price(sn.price, sn.currency)}, ingresso sotto ${price(plan.entry, sn.currency)}, stop ${price(plan.stop, sn.currency)}, obiettivo ${price(plan.target, sn.currency)}.`)
    };
  });

  return { updated: Date.now(), analysis: runLabel, totals, summary, items, suggestions };
}
