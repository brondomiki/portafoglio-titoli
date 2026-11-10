// Analisi tecnica semplice: medie mobili, RSI, momentum, tendenza stimata.
// NON è consulenza finanziaria: sono segnali automatici basati sui prezzi passati.

const sma = (a, n) => (a.length >= n ? a.slice(-n).reduce((s, x) => s + x, 0) / n : null);

function rsi(a, n = 14) {
  if (a.length <= n) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) {
    const d = a[i] - a[i - 1];
    d > 0 ? (g += d) : (l -= d);
  }
  g /= n; l /= n;
  for (let i = n + 1; i < a.length; i++) {
    const d = a[i] - a[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n;
    l = (l * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (l === 0) return 100;
  return 100 - 100 / (1 + g / l);
}

// regressione lineare sui logaritmi → variazione % attesa su `ahead` sedute
function trendProjection(a, lookback = 60, ahead = 21) {
  const s = a.slice(-lookback);
  if (s.length < 20) return null;
  const y = s.map(Math.log);
  const n = y.length;
  const mx = (n - 1) / 2;
  const my = y.reduce((p, v) => p + v, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - mx) * (y[i] - my); den += (i - mx) ** 2; }
  const slope = num / den;
  // affidabilità (R²)
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < n; i++) {
    const fit = my + slope * (i - mx);
    ssTot += (y[i] - my) ** 2; ssRes += (y[i] - fit) ** 2;
  }
  const r2 = ssTot ? 1 - ssRes / ssTot : 0;
  return { pct: (Math.exp(slope * ahead) - 1) * 100, r2 };
}

export function indicators(history, price) {
  const c = history.map((h) => h[1]);
  if (price != null && c.length) c[c.length - 1] = price;
  const last = c.at(-1);
  const ago = (d) => (c.length > d ? c[c.length - 1 - d] : null);
  const rets = [];
  for (let i = Math.max(1, c.length - 120); i < c.length; i++) rets.push(Math.log(c[i] / c[i - 1]));
  const mean = rets.reduce((s, x) => s + x, 0) / (rets.length || 1);
  const vol = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length || 1)) * Math.sqrt(252) * 100;
  const y = c.slice(-252);
  return {
    last,
    sma20: sma(c, 20),
    sma50: sma(c, 50),
    sma200: sma(c, 200),
    rsi: rsi(c.slice(-200)),
    mom1m: ago(21) ? (last / ago(21) - 1) * 100 : null,
    mom3m: ago(63) ? (last / ago(63) - 1) * 100 : null,
    high52: Math.max(...y),
    low52: Math.min(...y),
    low20: Math.min(...c.slice(-20)),
    high20: Math.max(...c.slice(-20)),
    vol,
    proj: trendProjection(c)
  };
}

const f2 = (x) => x.toLocaleString('it-IT', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const p1 = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`;

// Valutazione tecnica generica (senza posizione)
export function technicalScore(ind) {
  const reasons = [];
  let score = 0;
  const p = ind.last;
  if (ind.sma50) {
    if (p > ind.sma50) { score++; reasons.push(['+', 'Prezzo sopra la media a 50 giorni (trend di breve positivo)']); }
    else { score--; reasons.push(['-', 'Prezzo sotto la media a 50 giorni (trend di breve debole)']); }
  }
  if (ind.sma200) {
    if (p > ind.sma200) { score++; reasons.push(['+', 'Sopra la media a 200 giorni (trend di lungo positivo)']); }
    else { score--; reasons.push(['-', 'Sotto la media a 200 giorni (trend di lungo negativo)']); }
    if (ind.sma50) {
      if (ind.sma50 > ind.sma200) score += 0.5;
      else score -= 0.5;
    }
  }
  if (ind.mom3m != null) {
    if (ind.mom3m > 5) { score++; reasons.push(['+', `Momentum a 3 mesi ${p1(ind.mom3m)}`]); }
    else if (ind.mom3m < -5) { score--; reasons.push(['-', `Momentum a 3 mesi ${p1(ind.mom3m)}`]); }
  }
  if (ind.rsi != null) {
    if (ind.rsi > 72) { score -= 0.5; reasons.push(['-', `RSI ${ind.rsi.toFixed(0)}: ipercomprato, possibili prese di profitto`]); }
    else if (ind.rsi < 30) { score += 0.5; reasons.push(['+', `RSI ${ind.rsi.toFixed(0)}: ipervenduto, possibile rimbalzo`]); }
  }
  const dd = (p / ind.high52 - 1) * 100;
  if (dd < -25) { score -= 0.5; reasons.push(['-', `${dd.toFixed(0)}% dal massimo a 52 settimane`]); }
  if (ind.proj && ind.proj.r2 > 0.3) {
    const t = ind.proj.pct;
    if (t > 2) { score += 0.5; reasons.push(['+', `Tendenza stimata a 1 mese ${p1(t)}`]); }
    else if (t < -2) { score -= 0.5; reasons.push(['-', `Tendenza stimata a 1 mese ${p1(t)}`]); }
  }
  return { score, reasons };
}

// Valutazione di un titolo posseduto: cosa fare
export function evaluatePosition(ind, pos) {
  const { score, reasons } = technicalScore(ind);
  const plPct = pos.cost > 0 ? (pos.value / pos.cost - 1) * 100 : 0;
  let action, tone, detail;
  if (score >= 2.5) {
    action = 'Accumula'; tone = 'pos';
    detail = `Trend solido. Eventuali acquisti aggiuntivi su ritracciamenti verso ${f2(Math.max(ind.sma20 || 0, ind.low20))}.`;
  } else if (score >= 1) {
    action = 'Mantieni'; tone = 'pos';
    detail = 'Quadro positivo: mantenere la posizione, senza inseguire il prezzo.';
  } else if (score > -1.5) {
    action = 'Attendi'; tone = 'neu';
    detail = 'Segnali misti: nessuna azione urgente, ricontrollare a breve.';
  } else if (score > -3) {
    action = 'Alleggerisci'; tone = 'neg';
    detail = 'Trend in peggioramento: valutare una riduzione parziale della posizione.';
  } else {
    action = 'Valuta vendita'; tone = 'neg';
    detail = 'Segnali negativi su più orizzonti e tendenza in calo: considerare l\'uscita.';
  }
  if (plPct > 30 && ind.rsi > 70) {
    detail += ` Guadagno ${p1(plPct)} con titolo ipercomprato: possibile presa di profitto parziale.`;
    if (tone === 'pos') action = 'Prendi profitto parziale';
  }
  if (plPct < -15 && score < 0) {
    detail += ` Perdita ${p1(plPct)}: definire un livello di stop (es. sotto ${f2(ind.low52 * 0.98)}).`;
  }
  const stop = Math.min(ind.low20, ind.sma50 || ind.low20) * 0.97;
  return { action, tone, detail, reasons, score, stop, plPct };
}

// Suggerimento d'ingresso per un titolo osservato
export function entryPlan(ind) {
  const { score, reasons } = technicalScore(ind);
  const p = ind.last;
  const supports = [ind.sma20, ind.sma50, ind.low20].filter((x) => x && x < p);
  let entry = supports.length ? Math.max(...supports) : ind.low20;
  if (score < 0) entry = Math.min(entry, ind.low20); // in trend debole attendere livelli più bassi
  entry = Math.min(entry, p);
  const dist = (p / entry - 1) * 100;
  const stop = entry * (1 - Math.min(0.12, Math.max(0.05, ind.vol / 100 / 3)));
  const target = Math.max(ind.high52, entry * 1.1);
  let status;
  if (score < -1) status = { label: 'Trend negativo – attendere', tone: 'neg' };
  else if (dist <= 1.5) status = { label: 'In zona d\'ingresso', tone: 'pos' };
  else if (dist <= 5) status = { label: 'Vicino all\'ingresso', tone: 'neu' };
  else status = { label: 'Attendere ritracciamento', tone: 'neu' };
  return { score, reasons, entry, dist, stop, target, status };
}
