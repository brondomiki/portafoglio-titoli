import { drawChart, sparkline } from './chart.js';
import { indicators, evaluatePosition, entryPlan, livePlan, UNIVERSE } from './analysis.js';

const REFRESH_MS = 5 * 60 * 1000; // storico completo e suggerimenti
const LIVE_MS = 10 * 1000;         // prezzi in tempo reale

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const params = new URLSearchParams(location.search);
const MINI = params.get('view') === 'mini';

const S = {
  db: null, user: null, mode: null,
  tx: [], watch: [],
  quotes: {}, uni: {}, updated: null,
  range: localStorage.getItem('pf_range') || '6M',
  holdings: {}, series: [],
  runs: [], pip: null, loading: false
};

/* ---------- formattazione ---------- */
const eur = (v, d = 2) => (v == null || !isFinite(v) ? '—' : v.toLocaleString('it-IT', { style: 'currency', currency: 'EUR', minimumFractionDigits: d, maximumFractionDigits: d }));
const sEur = (v) => (v == null || !isFinite(v) ? '—' : (v >= 0 ? '+' : '−') + eur(Math.abs(v)));
const pct = (v) => (v == null || !isFinite(v) ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`);
const num = (v, d = 4) => (v == null ? '—' : (+v).toLocaleString('it-IT', { maximumFractionDigits: d }));
const price = (v, cur) => {
  if (v == null || !isFinite(v)) return '—';
  const d = v < 2 ? 4 : 2;
  try { return v.toLocaleString('it-IT', { style: 'currency', currency: cur === 'GBp' ? 'GBP' : cur || 'EUR', minimumFractionDigits: d, maximumFractionDigits: d }).replace('£', cur === 'GBp' ? 'p ' : '£'); }
  catch { return `${num(v, d)} ${cur || ''}`; }
};
const EXT_LABEL = { pre: 'Pre-market', post: 'After-hours' };
// prezzo fuori orario (titoli USA): etichetta, prezzo, variazione e impatto in euro sulla posizione
function extInfo(h) {
  const e = h.quote?.ext;
  if (!e || e.price == null) return null;
  const eurImpact = h.fx != null && h.price != null ? h.qty * (e.price - h.price) * h.fx : null;
  return { ...e, label: EXT_LABEL[e.type] || 'Fuori orario', eurImpact };
}
const extTime = (t) => new Date(t).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
const cls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => new Date().toISOString().slice(0, 10);
const dayKey = (t) => new Date(t).toISOString().slice(0, 10);

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms);
}

/* ---------- archivio dati: Supabase oppure locale ---------- */
const local = {
  get: (k) => { try { return JSON.parse(localStorage.getItem(k) || '[]'); } catch { return []; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v))
};
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));

const store = {
  async listTx() {
    if (S.mode === 'local') return local.get('pf_tx');
    const { data, error } = await S.db.from('transactions').select('*').order('trade_date').order('created_at');
    if (error) throw error; return data;
  },
  async addTx(t) {
    if (S.mode === 'local') { const a = local.get('pf_tx'); const r = { ...t, id: uid(), created_at: new Date().toISOString() }; a.push(r); local.set('pf_tx', a); return r; }
    const { data, error } = await S.db.from('transactions').insert(t).select().single();
    if (error) throw error; return data;
  },
  async delTx(id) {
    if (S.mode === 'local') { local.set('pf_tx', local.get('pf_tx').filter((x) => x.id !== id)); return; }
    const { error } = await S.db.from('transactions').delete().eq('id', id); if (error) throw error;
  },
  async listWatch() {
    if (S.mode === 'local') return local.get('pf_watch');
    const { data, error } = await S.db.from('watchlist').select('*').order('created_at');
    if (error) throw error; return data;
  },
  async addWatch(w) {
    if (S.mode === 'local') { const a = local.get('pf_watch').filter((x) => x.symbol !== w.symbol); const r = { ...w, id: uid() }; a.push(r); local.set('pf_watch', a); return r; }
    const { data, error } = await S.db.from('watchlist').upsert(w, { onConflict: 'user_id,symbol' }).select().single();
    if (error) throw error; return data;
  },
  async delWatch(id) {
    if (S.mode === 'local') { local.set('pf_watch', local.get('pf_watch').filter((x) => x.id !== id)); return; }
    const { error } = await S.db.from('watchlist').delete().eq('id', id); if (error) throw error;
  }
};

/* ---------- prezzi ---------- */
async function fetchQuotes(symbols, range = '1y') {
  if (!symbols.length) return {};
  const r = await fetch(`/api/quote?symbols=${encodeURIComponent(symbols.join(','))}&range=${range}`);
  if (!r.ok) throw new Error(`Servizio prezzi non disponibile (${r.status})`);
  const j = await r.json();
  const errs = Object.keys(j.errors || {});
  if (errs.length) console.warn('Simboli non trovati:', j.errors);
  return j.quotes || {};
}

function neededRange() {
  if (!S.tx.length) return '1y';
  const first = new Date(S.tx.map((t) => t.trade_date).sort()[0]);
  const days = (Date.now() - first) / 864e5;
  return days < 360 ? '1y' : days < 720 ? '2y' : days < 1800 ? '5y' : 'max';
}

/* ---------- calcolo posizioni (metodo del costo medio) ---------- */
function applyTx(h, t) {
  const q = +t.quantity, p = +t.price, f = +t.fees || 0;
  if (t.side === 'buy') { h.qty += q; h.cost += q * p + f; }
  else {
    const avg = h.qty > 0 ? h.cost / h.qty : 0;
    const sold = Math.min(q, h.qty);
    h.realized += sold * (p - avg) - f;
    h.cost -= avg * sold; h.qty -= sold;
    if (h.qty < 1e-9) { h.qty = 0; h.cost = 0; }
  }
}
const sortTx = (a) => [...a].sort((x, y) => (x.trade_date + (x.created_at || '')).localeCompare(y.trade_date + (y.created_at || '')));

function computeHoldings() {
  const H = {};
  for (const t of sortTx(S.tx)) {
    const h = (H[t.symbol] ||= { symbol: t.symbol, name: t.name || t.symbol, currency: t.currency, qty: 0, cost: 0, realized: 0 });
    applyTx(h, t);
  }
  for (const h of Object.values(H)) {
    const q = S.quotes[h.symbol];
    const fx = q?.fxToEur ?? (h.currency === 'EUR' || !h.currency ? 1 : null);
    h.quote = q; h.fx = fx;
    h.price = q?.price ?? null;
    h.valueEur = h.price != null && fx != null ? h.qty * h.price * fx : null;
    h.costEur = fx != null ? h.cost * fx : null;
    h.realizedEur = fx != null ? h.realized * fx : 0;
    h.dayEur = q?.prevClose && fx != null ? h.qty * (q.price - q.prevClose) * fx : 0;
    h.dayPct = q?.prevClose ? (q.price / q.prevClose - 1) * 100 : null;
    h.avg = h.qty ? h.cost / h.qty : null;
    if (q?.name) h.name = q.name;
  }
  S.holdings = H;
}

function computeSeries() {
  const syms = [...new Set(S.tx.map((t) => t.symbol))];
  if (!syms.length) return (S.series = []);
  const txBy = {}; const closes = {}; const days = new Set();
  const start = S.tx.map((t) => t.trade_date).sort()[0];
  for (const s of syms) {
    txBy[s] = sortTx(S.tx.filter((t) => t.symbol === s));
    closes[s] = new Map();
    for (const [t, c] of S.quotes[s]?.history || []) { const k = dayKey(t); closes[s].set(k, c); if (k >= start) days.add(k); }
  }
  days.add(start);
  const sorted = [...days].sort();
  const st = Object.fromEntries(syms.map((s) => [s, { h: { qty: 0, cost: 0, realized: 0 }, i: 0, last: null }]));
  const out = [];
  for (const d of sorted) {
    let v = 0, b = 0, ok = true;
    for (const s of syms) {
      const x = st[s];
      while (x.i < txBy[s].length && txBy[s][x.i].trade_date <= d) { applyTx(x.h, txBy[s][x.i]); if (x.last == null) x.last = +txBy[s][x.i].price; x.i++; }
      const c = closes[s].get(d); if (c != null) x.last = c;
      const fx = S.quotes[s]?.fxToEur ?? 1;
      if (x.h.qty > 0) { if (x.last == null) ok = false; v += x.h.qty * (x.last || 0) * fx; b += x.h.cost * fx; }
    }
    if (ok) out.push({ t: new Date(d + 'T12:00:00').getTime(), v, b });
  }
  // punto attuale
  let v = 0, b = 0;
  for (const h of Object.values(S.holdings)) if (h.qty > 0 && h.valueEur != null) { v += h.valueEur; b += h.costEur; }
  if (out.length && dayKey(out.at(-1).t) === today()) out.pop();
  out.push({ t: Date.now(), v, b });
  S.series = out;
}

function rangeSlice(series) {
  const map = { '1M': 31, '3M': 92, '6M': 183, '1A': 366 };
  if (!map[S.range]) return series;
  const from = Date.now() - map[S.range] * 864e5;
  const s = series.filter((p) => p.t >= from);
  return s.length >= 2 ? s : series.slice(-2);
}

function totals() {
  let value = 0, cost = 0, day = 0, realized = 0, prevValue = 0;
  for (const h of Object.values(S.holdings)) {
    realized += h.realizedEur || 0;
    if (h.qty > 0 && h.valueEur != null) { value += h.valueEur; cost += h.costEur; day += h.dayEur; prevValue += h.valueEur - h.dayEur; }
  }
  return { value, cost, pl: value - cost, plPct: cost ? (value / cost - 1) * 100 : 0, day, dayPct: prevValue ? (day / prevValue) * 100 : 0, realized };
}

/* ---------- analisi programmata (mattina e pomeriggio) ---------- */
const SLOT_LABEL = { mattina: 'del mattino', pomeriggio: 'del pomeriggio', manuale: 'manuale' };
const snap = (sym) => S.runs[0]?.data?.syms?.[sym] || null;
const prevSnap = (sym) => S.runs[1]?.data?.syms?.[sym] || null;
function runInfo() {
  const r = S.runs[0];
  if (!r) return '';
  const d = new Date(r.run_at);
  const when = d.toDateString() === new Date().toDateString() ? `oggi alle ${d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}` : d.toLocaleString('it-IT', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return `Analisi ${SLOT_LABEL[r.slot] || ''} · ${when}`;
}
function nextRunLabel() {
  const now = new Date();
  const rome = (d) => +new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', hourCycle: 'h23' }).format(d);
  const dow = now.getDay(), h = rome(now);
  if (dow >= 1 && dow <= 5 && h < 8) return 'prossima stamattina verso le 8:30';
  if (dow >= 1 && dow <= 5 && h < 15) return 'prossima oggi verso le 15:00';
  return dow === 5 || dow === 6 ? 'prossima lunedì verso le 8:30' : 'prossima domani verso le 8:30';
}
async function loadAnalysis({ notify = false } = {}) {
  try {
    const r = await fetch('/api/analysis', { cache: 'no-store' });
    if (!r.ok) return;
    const { runs = [] } = await r.json();
    const changed = runs[0]?.id !== S.runs[0]?.id;
    S.runs = runs;
    if (changed) {
      if (notify && runs[0]) toast(`Nuove valutazioni ${SLOT_LABEL[runs[0].slot] || ''} disponibili`, 4000);
      if (!MINI) { await loadSuggestionQuotes(); renderAll(); }
    }
  } catch {}
}
async function runAnalysisNow() {
  if (S.mode !== 'cloud') return toast("Serve l'accesso con account per aggiornare l'analisi");
  const { data } = await S.db.auth.getSession();
  toast('Analisi in corso… (circa 20 secondi)', 20000);
  const r = await fetch('/api/analysis', { method: 'POST', headers: { Authorization: `Bearer ${data.session?.access_token}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return toast(j.error || 'Analisi non riuscita', 6000);
  toast(j.skipped ? 'Analisi già aggiornata da pochi minuti' : `Analisi completata: ${j.analyzed} titoli`, 4000);
  S.runs = [];
  await loadAnalysis();
}
// piano d'ingresso: livelli dell'ultima analisi, stato sul prezzo attuale
function planFor(sym, q) {
  const sn = snap(sym);
  if (sn) return livePlan(entryPlan(sn.ind), q?.price ?? sn.price);
  return q?.history?.length > 60 ? entryPlan(indicators(q.history, q.price)) : null;
}
function suggestedSymbols() {
  const exclude = new Set([...S.watch.map((w) => w.symbol), ...Object.values(S.holdings).filter((h) => h.qty > 0).map((h) => h.symbol)]);
  const ranked = S.runs[0]?.data?.ranked;
  if (ranked) return ranked.filter((x) => !exclude.has(x)).slice(0, 8);
  return UNIVERSE.filter((x) => !exclude.has(x) && S.uni[x]?.history?.length > 60)
    .map((x) => ({ x, plan: entryPlan(indicators(S.uni[x].history, S.uni[x].price)) }))
    .sort((a, b) => b.plan.score - a.plan.score || a.plan.dist - b.plan.dist)
    .slice(0, 8).map((r) => r.x);
}
async function loadSuggestionQuotes() {
  const want = S.runs[0]?.data?.ranked ? S.runs[0].data.ranked.slice(0, 16) : UNIVERSE;
  const missing = [...new Set(want.concat(S.watch.map((w) => w.symbol)))].filter((x) => !S.quotes[x] && !S.uni[x]);
  if (missing.length) Object.assign(S.uni, await fetchQuotes(missing, '1y').catch(() => ({})));
  for (const x of want) if (S.quotes[x]) S.uni[x] = S.quotes[x];
}

/* ---------- rendering ---------- */
function renderHeader() {
  const T = totals();
  $('#hdrTotal').textContent = eur(T.value);
  $('#hdrDay').innerHTML = `<span class="${cls(T.day)}">${sEur(T.day)} (${pct(T.dayPct)})</span> oggi`;
  $('#kValue').textContent = eur(T.value);
  $('#kCost').textContent = eur(T.cost);
  $('#kPL').innerHTML = `<span class="${cls(T.pl)}">${sEur(T.pl)} <small>${pct(T.plPct)}</small></span>${T.realized ? `<br><small class="muted">Realizzato ${sEur(T.realized)}</small>` : ''}`;
  $('#kDay').innerHTML = `<span class="${cls(T.day)}">${sEur(T.day)}</span>`;
  const s = rangeSlice(S.series);
  const per = s.length >= 2 ? (s.at(-1).v - s.at(-1).b) - (s[0].v - s[0].b) : 0;
  $('#kPeriod').innerHTML = `<span class="${cls(per)}">${sEur(per)}</span>`;
  $('#updated').textContent = S.updated ? `● Live · aggiornato alle ${new Date(S.updated).toLocaleTimeString('it-IT')} (ogni 10 s)` : '';
  document.title = S.series.length ? `${eur(T.value, 0)} ${T.day >= 0 ? '▲' : '▼'} ${pct(T.dayPct)} · Portafoglio` : 'Portafoglio';
}

function renderChart() {
  drawChart($('#mainChart'), rangeSlice(S.series), {
    interactive: true,
    format: (v) => eur(v),
    tipExtra: (p) => `<br>Investito ${eur(p.b)}<br><span>${sEur(p.v - p.b)} (${pct(p.b ? (p.v / p.b - 1) * 100 : 0)})</span>`
  });
}

function renderHoldings() {
  const list = Object.values(S.holdings).filter((h) => h.qty > 0).sort((a, b) => (b.valueEur || 0) - (a.valueEur || 0));
  const el = $('#holdings');
  if (!list.length) { el.innerHTML = `<div class="empty">Nessun titolo. Premi <b>+ Operazione</b> per registrare il primo acquisto.</div>`; return; }
  el.innerHTML = list.map((h) => {
    const pl = h.valueEur != null ? h.valueEur - h.costEur : null;
    const plp = h.costEur ? (h.valueEur / h.costEur - 1) * 100 : null;
    const adv = h.eval;
    return `<div class="hold">
      <div style="min-width:0">
        <div class="sym">${esc(h.symbol)} ${adv ? `<span class="badge ${adv.tone}">${esc(adv.action)}</span>` : ''}</div>
        <div class="nm">${esc(h.name)}</div>
        <div class="meta">${num(h.qty)} × ${price(h.avg, h.currency)} · ora ${price(h.price, h.currency)}</div>
        ${(() => { const x = extInfo(h); return x ? `<div class="ext" title="Ultimo scambio ${x.label.toLowerCase()} alle ${extTime(x.time)}"><span class="ext-tag ${x.type}">${x.label}</span> <b>${price(x.price, h.currency)}</b> <span class="${cls(x.changePct)}">${pct(x.changePct)}</span>${x.eurImpact != null ? ` <span class="${cls(x.eurImpact)}">(${sEur(x.eurImpact)})</span>` : ''} <span class="muted">${extTime(x.time)}</span></div>` : ''; })()}
      </div>
      <canvas data-spark="${esc(h.symbol)}"></canvas>
      <div class="right">
        <b>${eur(h.valueEur)}</b>
        <span class="${cls(pl)}">${sEur(pl)} (${pct(plp)})</span><br>
        <small class="${cls(h.dayPct)}">oggi ${pct(h.dayPct)}</small>
        <div class="ops"><button class="mini-btn buy" data-trade="buy" data-sym="${esc(h.symbol)}">Compra</button><button class="mini-btn sell" data-trade="sell" data-sym="${esc(h.symbol)}">Vendi</button></div>
      </div>
    </div>`;
  }).join('');
  $$('canvas[data-spark]', el).forEach((c) => {
    const hist = S.quotes[c.dataset.spark]?.history || [];
    sparkline(c, hist.slice(-63));
  });
}

function renderAdvice() {
  const list = Object.values(S.holdings).filter((h) => h.qty > 0);
  const el = $('#advice');
  $('#adviceInfo').textContent = S.runs[0] ? `${runInfo()} — ${nextRunLabel()}` : 'Valutazione sui prezzi attuali (analisi programmata non ancora disponibile)';
  if (!list.length) { el.innerHTML = `<div class="empty">Le valutazioni compariranno quando avrai titoli in portafoglio.</div>`; return; }
  el.innerHTML = list.map((h) => {
    const e = h.eval;
    if (!e) return `<div class="adv"><div class="adv-head"><b>${esc(h.symbol)}</b><span class="badge neu">Dati insufficienti</span></div></div>`;
    const proj = e.ind.proj;
    return `<div class="adv">
      <div class="adv-head"><b>${esc(h.symbol)} <small class="muted">${esc(h.name)}</small></b><span>${e.prevAction && e.prevAction !== e.action ? `<small class="muted">prima: ${esc(e.prevAction)} → </small>` : ''}<span class="badge ${e.tone}">${esc(e.action)}</span></span></div>
      <p>${esc(e.detail)}</p>
      ${proj ? `<div class="proj">Tendenza stimata a 1 mese: <b class="${cls(proj.pct)}">${pct(proj.pct)}</b> <span class="muted">(affidabilità ${proj.r2 > 0.6 ? 'alta' : proj.r2 > 0.3 ? 'media' : 'bassa'})</span> · Stop indicativo: <b>${price(e.stop, h.currency)}</b></div>` : ''}
      <ul>${e.reasons.map(([s, r]) => `<li class="${s === '+' ? 'p' : 'm'}">${esc(r)}</li>`).join('')}</ul>
    </div>`;
  }).join('');
}

function watchCard(sym, q, plan, mine, isNew = false) {
  const day = q.prevClose ? (q.price / q.prevClose - 1) * 100 : null;
  const target = mine?.target_price;
  const hit = target && q.price <= target;
  return `<div class="w ${mine ? 'mine' : ''}">
    ${mine ? `<button class="del x" data-delwatch="${esc(mine.id)}" title="Rimuovi">×</button>` : ''}
    <div class="w-head">
      <div style="min-width:0"><b>${esc(sym)}</b>${isNew ? ' <span class="badge pos">Nuovo</span>' : ''}<div class="nm">${esc(q.name)}</div></div>
      <div style="text-align:right;${mine ? 'margin-right:22px' : ''}"><b class="num">${price(q.price, q.currency)}</b><br><small class="${cls(day)}">${pct(day)}</small></div>
    </div>
    <canvas data-wspark="${esc(sym)}"></canvas>
    <dl>
      <div><dt>Ingresso ≤</dt><dd>${price(plan.entry, q.currency)}</dd></div>
      <div><dt>Stop</dt><dd>${price(plan.stop, q.currency)}</dd></div>
      <div><dt>Obiettivo</dt><dd>${price(plan.target, q.currency)}</dd></div>
    </dl>
    ${target ? `<div class="${hit ? 'pos' : 'muted'}" style="font-size:12.5px">${hit ? '✓ Sotto il tuo prezzo obiettivo' : 'Tuo obiettivo'}: <b>${price(+target, q.currency)}</b></div>` : ''}
    <div class="w-foot">
      <span class="badge ${plan.status.tone}" title="${esc(plan.reasons.map((r) => r[1]).join(' · '))}">${esc(plan.status.label)}</span>
      <span>
        ${mine ? '' : `<button class="mini-btn" data-watchadd="${esc(sym)}">Osserva</button>`}
        <button class="mini-btn buy" data-trade="buy" data-sym="${esc(sym)}">Compra</button>
      </span>
    </div>
  </div>`;
}

function renderWatch() {
  const el = $('#watch');
  const cards = [];
  for (const w of S.watch) {
    const q = S.uni[w.symbol] || S.quotes[w.symbol];
    if (!q?.history?.length) { cards.push(`<div class="w mine"><button class="del x" data-delwatch="${esc(w.id)}">×</button><b>${esc(w.symbol)}</b><span class="muted">Caricamento dati…</span></div>`); continue; }
    const plan = planFor(w.symbol, q);
    if (plan) cards.push(watchCard(w.symbol, q, plan, w));
  }
  const prevTop = new Set(S.runs[1]?.data?.ranked?.slice(0, 12) || []);
  const ranked = suggestedSymbols()
    .map((x) => { const sn = snap(x); const q = S.uni[x] || S.quotes[x] || (sn && { symbol: x, name: sn.name, currency: sn.currency, price: sn.price, prevClose: null, history: [] }); return { x, q, plan: planFor(x, q), isNew: S.runs[1] && !prevTop.has(x) }; })
    .filter((r) => r.q && r.plan);
  const info = S.runs[0] ? `${runInfo()} su ${S.runs[0].data.universe} titoli — ${nextRunLabel()}.` : 'Calcolati sui prezzi attuali.';
  if (ranked.length) {
    cards.push(`<div style="grid-column:1/-1" class="hint"><b>Suggeriti</b> — i titoli con il quadro tecnico migliore tra una selezione diversificata (Italia, Europa, USA, ETF). ${esc(info)}</div>`);
    for (const r of ranked) cards.push(watchCard(r.x, r.q, r.plan, null, r.isNew));
  } else if (!Object.keys(S.uni).length) cards.push(`<div class="empty" style="grid-column:1/-1">Caricamento suggerimenti…</div>`);
  el.innerHTML = cards.join('');
  $$('canvas[data-wspark]', el).forEach((c) => sparkline(c, (S.uni[c.dataset.wspark] || S.quotes[c.dataset.wspark])?.history?.slice(-126) || []));
}

function renderTx() {
  const el = $('#txList');
  if (!S.tx.length) { el.innerHTML = `<div class="empty">Nessun movimento registrato.</div>`; return; }
  el.innerHTML = sortTx(S.tx).reverse().map((t) => `<div class="tx">
    <span class="side ${t.side}">${t.side === 'buy' ? 'ACQ' : 'VEN'}</span>
    <div style="min-width:0"><b>${esc(t.symbol)}</b> <small class="muted">${new Date(t.trade_date).toLocaleDateString('it-IT')}</small>${t.note ? `<br><small class="muted">${esc(t.note)}</small>` : ''}</div>
    <div style="text-align:right">${num(t.quantity)} × ${price(+t.price, t.currency)}<br><small class="muted">${+t.fees ? `comm. ${num(t.fees, 2)}` : ''}</small></div>
    <button class="del" data-deltx="${esc(t.id)}" title="Elimina">×</button>
  </div>`).join('');
}

function renderMini(root) {
  if (!root) return;
  const T = totals();
  const k = (n) => root.querySelector(`[data-k="${n}"]`);
  k('total').textContent = eur(T.value);
  k('day').innerHTML = `<span class="${cls(T.day)}">${sEur(T.day)} (${pct(T.dayPct)})</span>`;
  const extSum = Object.values(S.holdings).filter((h) => h.qty > 0).map(extInfo).filter((x) => x && x.eurImpact != null);
  const extTot = extSum.reduce((a, x) => a + x.eurImpact, 0);
  const extType = extSum.some((x) => x.type === 'pre') ? 'Pre-market' : 'After-hours';
  k('pl').innerHTML = `Totale<br><b class="${cls(T.pl)}">${pct(T.plPct)}</b>${extSum.length ? `<br><small>${extType} <b class="${cls(extTot)}">${sEur(extTot)}</b></small>` : ''}`;
  const list = Object.values(S.holdings).filter((h) => h.qty > 0).sort((a, b) => (b.valueEur || 0) - (a.valueEur || 0));
  k('list').innerHTML = list.length ? list.map((h) => {
    const plp = h.costEur ? (h.valueEur / h.costEur - 1) * 100 : null;
    const x = extInfo(h);
    return `<div class="mini-row"><b>${esc(h.symbol)}</b><span class="${cls(h.dayPct)}">${pct(h.dayPct)}</span><span class="${cls(plp)}">${pct(plp)}</span>${x ? `<div class="mini-ext"><span class="ext-tag ${x.type}">${x.type === 'pre' ? 'Pre' : 'After'}</span> ${price(x.price, h.currency)} <span class="${cls(x.changePct)}">${pct(x.changePct)}</span></div>` : ''}</div>`;
  }).join('') : '<div class="muted" style="text-align:center;padding:10px">Nessun titolo</div>';
  k('time').textContent = S.updated ? `colonne: oggi · totale — agg. ${new Date(S.updated).toLocaleTimeString('it-IT')}` : '';
  requestAnimationFrame(() => drawChart(k('chart'), S.series.filter((p) => p.t >= Date.now() - 92 * 864e5), { lineWidth: 1.5, padTop: 2, padBottom: 2 }));
}

function renderAll() {
  computeHoldings();
  for (const h of Object.values(S.holdings)) {
    const q = h.quote;
    const pos = { value: h.valueEur, cost: h.costEur };
    const sn = snap(h.symbol), pv = prevSnap(h.symbol);
    const ind = sn ? sn.ind : q?.history?.length > 60 ? indicators(q.history, q.price) : null;
    h.eval = ind && h.qty > 0 ? { ...evaluatePosition(ind, pos), ind, prevAction: pv ? evaluatePosition(pv.ind, pos).action : null } : null;
  }
  computeSeries();
  if (MINI) { renderMini($('.mini')); return; }
  renderHeader(); renderChart(); renderHoldings(); renderAdvice(); renderWatch(); renderTx();
  if (S.pip) renderMini(S.pip.document.querySelector('.mini'));
}

/* ---------- caricamento ---------- */
async function refresh({ quiet = false } = {}) {
  if (S.loading) return; S.loading = true;
  $('#refreshBtn')?.classList.add('spin');
  try {
    const syms = [...new Set([...S.tx.map((t) => t.symbol), ...S.watch.map((w) => w.symbol)])];
    if (syms.length) {
      const q = await fetchQuotes(syms, neededRange());
      Object.assign(S.quotes, q);
      try { localStorage.setItem('pf_cache', JSON.stringify({ quotes: S.quotes, updated: Date.now() })); } catch {}
    }
    S.updated = Date.now();
    renderAll();
    if (!MINI) {
      S.uni = {};
      await loadSuggestionQuotes();
      renderWatch();
    }
    if (!quiet) toast('Prezzi aggiornati');
  } catch (e) {
    console.error(e);
    toast(e.message || 'Errore di aggiornamento', 4000);
  } finally {
    S.loading = false;
    $('#refreshBtn')?.classList.remove('spin');
  }
}

async function loadData() {
  [S.tx, S.watch] = await Promise.all([store.listTx(), store.listWatch()]);
  try { const c = JSON.parse(localStorage.getItem('pf_cache') || 'null'); if (c) { S.quotes = c.quotes || {}; S.updated = c.updated; } } catch {}
  renderAll();
  await loadAnalysis();
  await refresh({ quiet: true });
}


/* ---------- aggiornamento prezzi ogni 10 secondi ---------- */
async function liveTick() {
  if (S.loading || S.live) return;
  if (document.visibilityState !== 'visible' && !S.pip) return;
  const syms = [...new Set([...Object.values(S.holdings).filter((h) => h.qty > 0).map((h) => h.symbol), ...S.watch.map((w) => w.symbol)])];
  if (!syms.length) return;
  S.live = true;
  try {
    const r = await fetch(`/api/quote?symbols=${encodeURIComponent(syms.join(','))}&range=5d&live=1`, { cache: 'no-store' });
    if (!r.ok) return;
    const { quotes = {} } = await r.json();
    let changed = false;
    for (const [sym, q] of Object.entries(quotes)) {
      for (const base of [S.quotes[sym], S.uni[sym]]) {
        if (!base || q.price == null) continue;
        if (base.price !== q.price || base.prevClose !== q.prevClose || base.ext?.price !== q.ext?.price) changed = true;
        base.ext = q.ext ?? null;
        base.price = q.price;
        if (q.prevClose != null) base.prevClose = q.prevClose;
        if (q.fxToEur != null) base.fxToEur = q.fxToEur;
        base.time = q.time;
        const h = base.history || [];
        const last = q.history?.at(-1);
        if (last) {
          if (h.length && dayKey(h.at(-1)[0]) === dayKey(last[0])) h[h.length - 1] = [last[0], q.price];
          else h.push([last[0], q.price]);
        }
      }
    }
    S.updated = Date.now();
    if (changed) renderAll();
    else if (!MINI) renderHeader();
    else renderMini($('.mini'));
  } catch {} finally { S.live = false; }
}

/* ---------- ricerca titoli ---------- */
function attachSearch(input, box, onPick) {
  let h, ctl;
  input.addEventListener('input', () => {
    input._picked = null;
    clearTimeout(h);
    const q = input.value.trim();
    if (q.length < 2) { box.classList.remove('open'); return; }
    h = setTimeout(async () => {
      ctl?.abort(); ctl = new AbortController();
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctl.signal });
        const { results = [] } = await r.json();
        box.innerHTML = results.map((x) => `<button type="button" data-s="${esc(x.symbol)}" data-n="${esc(x.name)}"><b>${esc(x.symbol)}</b> ${esc(x.name)}<br><small>${esc(x.exchange)} · ${esc(x.type)}</small></button>`).join('') || '<button type="button" disabled>Nessun risultato</button>';
        box.classList.add('open');
      } catch {}
    }, 250);
  });
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-s]'); if (!b) return;
    input.value = `${b.dataset.s} — ${b.dataset.n}`;
    input._picked = { symbol: b.dataset.s, name: b.dataset.n };
    box.classList.remove('open');
    onPick?.(input._picked);
  });
  input.addEventListener('blur', () => setTimeout(() => box.classList.remove('open'), 200));
}
const pickedSymbol = (input) => input._picked || (input.value.trim() ? { symbol: input.value.trim().split(/\s|—/)[0].toUpperCase(), name: null } : null);

/* ---------- dialog operazione ---------- */
let side = 'buy';
function setSide(s) { side = s; $$('#sideSeg button').forEach((b) => b.classList.toggle('on', b.dataset.side === s)); $('#tradeTitle').textContent = s === 'buy' ? 'Nuovo acquisto' : 'Nuova vendita'; }

async function prefill(pick) {
  const q = S.quotes[pick.symbol] || S.uni[pick.symbol] || (await fetchQuotes([pick.symbol], '1mo').catch(() => ({})))[pick.symbol];
  if (!q) { $('#tMsg').textContent = 'Prezzo non trovato: inseriscilo a mano.'; return; }
  S.uni[pick.symbol] ||= q;
  $('#tPrice').value = q.price;
  $('#tCur').textContent = `(${q.currency})`;
  $('#tradeForm')._q = q;
  if (side === 'sell') { const h = S.holdings[pick.symbol]; if (h) $('#tQty').value = h.qty; }
}

function openTrade(s = 'buy', sym = null) {
  const f = $('#tradeForm'); f.reset(); f._q = null;
  setSide(s);
  $('#tDate').value = today(); $('#tFees').value = 0; $('#tMsg').textContent = ''; $('#tCur').textContent = '';
  const inp = $('#tSymbolSearch'); inp._picked = null;
  if (sym) {
    const q = S.quotes[sym] || S.uni[sym];
    inp.value = `${sym} — ${q?.name || ''}`; inp._picked = { symbol: sym, name: q?.name };
    prefill(inp._picked);
  }
  $('#tradeDlg').showModal();
  if (!sym) inp.focus();
}

async function saveTrade(e) {
  e.preventDefault();
  const pick = pickedSymbol($('#tSymbolSearch'));
  const qty = +$('#tQty').value, pr = +$('#tPrice').value;
  const msg = $('#tMsg');
  if (!pick) return (msg.textContent = 'Scegli un titolo.');
  if (!(qty > 0)) return (msg.textContent = 'Quantità non valida.');
  if (!(pr >= 0)) return (msg.textContent = 'Prezzo non valido.');
  if (side === 'sell') {
    const held = S.holdings[pick.symbol]?.qty || 0;
    if (qty > held + 1e-9) return (msg.textContent = `Puoi vendere al massimo ${num(held)} pezzi.`);
  }
  let q = $('#tradeForm')._q || S.quotes[pick.symbol] || S.uni[pick.symbol];
  if (!q) q = (await fetchQuotes([pick.symbol], '1mo').catch(() => ({})))[pick.symbol];
  if (!q) return (msg.textContent = `Simbolo "${pick.symbol}" non trovato.`);
  $('#tSave').disabled = true;
  try {
    const t = await store.addTx({
      symbol: q.symbol || pick.symbol, name: q.name || pick.name, side, quantity: qty, price: pr,
      fees: +$('#tFees').value || 0, currency: q.currency, trade_date: $('#tDate').value || today(), note: $('#tNote').value || null
    });
    S.tx.push(t);
    $('#tradeDlg').close();
    toast(side === 'buy' ? 'Acquisto registrato' : 'Vendita registrata');
    if (!S.quotes[t.symbol]) S.quotes[t.symbol] = q;
    renderAll();
    refresh({ quiet: true });
  } catch (err) { msg.textContent = err.message; }
  finally { $('#tSave').disabled = false; }
}

/* ---------- finestra flottante (Document Picture-in-Picture) ---------- */
async function openPip() {
  if (S.pip) { S.pip.focus(); return; }
  const w = await documentPictureInPicture.requestWindow({ width: 300, height: 420 });
  for (const l of $$('link[rel=stylesheet]')) { const n = w.document.createElement('link'); n.rel = 'stylesheet'; n.href = l.href; w.document.head.appendChild(n); }
  w.document.title = 'Portafoglio';
  w.document.body.className = 'mini-mode';
  w.document.body.appendChild($('#miniTpl').content.cloneNode(true));
  S.pip = w;
  w.addEventListener('pagehide', () => (S.pip = null));
  setTimeout(() => renderMini(w.document.querySelector('.mini')), 50);
}

/* ---------- autenticazione ---------- */
async function setupBackend() {
  if (localStorage.getItem('pf_mode') === 'local') { S.mode = 'local'; return true; }
  let cfg = {};
  try { cfg = await (await fetch('/api/config')).json(); } catch {}
  if (!cfg.url || !cfg.key) {
    $('#loginMsg').textContent = 'Supabase non configurato su Vercel: puoi usare l\'app in modalità locale.';
    return false;
  }
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  S.db = createClient(cfg.url, cfg.key, { auth: { persistSession: true, autoRefreshToken: true } });
  const { data } = await S.db.auth.getSession();
  if (data.session) { S.user = data.session.user; S.mode = 'cloud'; return true; }
  return false;
}

function showLogin() { $('#login').hidden = false; $('#app').hidden = true; }

async function startApp() {
  $('#login').hidden = true;
  if (MINI) {
    document.body.classList.add('mini-mode');
    document.body.appendChild($('#miniTpl').content.cloneNode(true));
  } else $('#app').hidden = false;
  $('#menuWho').textContent = S.mode === 'local' ? 'Modalità locale: i dati restano solo su questo dispositivo.' : `Accesso come ${S.user.email}`;
  $('#importLocalBtn').hidden = !(S.mode === 'cloud' && local.get('pf_tx').length);
  try { await loadData(); } catch (e) { toast(`Errore dati: ${e.message}`, 5000); }
  setInterval(() => document.visibilityState === 'visible' && refresh({ quiet: true }), REFRESH_MS);
  setInterval(liveTick, LIVE_MS);
  setInterval(() => loadAnalysis({ notify: true }), 15 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - (S.updated || 0) > 120000) refresh({ quiet: true });
  });
}

/* ---------- eventi ---------- */
function bind() {
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!S.db) return;
    const { data, error } = await S.db.auth.signInWithPassword({ email: $('#loginEmail').value, password: $('#loginPass').value });
    if (error) return ($('#loginMsg').textContent = error.message === 'Invalid login credentials' ? 'Email o password errate.' : error.message);
    S.user = data.user; S.mode = 'cloud'; startApp();
  });
  $('#signupBtn').addEventListener('click', async () => {
    if (!S.db) return;
    const email = $('#loginEmail').value, password = $('#loginPass').value;
    if (!email || password.length < 6) return ($('#loginMsg').textContent = 'Inserisci email e una password di almeno 6 caratteri.');
    const { data, error } = await S.db.auth.signUp({ email, password, options: { emailRedirectTo: location.origin } });
    if (error) return ($('#loginMsg').textContent = error.message);
    if (data.session) { S.user = data.user; S.mode = 'cloud'; startApp(); }
    else { $('#loginMsg').className = 'msg ok'; $('#loginMsg').textContent = 'Controlla la tua email per confermare l\'account, poi accedi.'; }
  });
  $('#localBtn').addEventListener('click', () => { localStorage.setItem('pf_mode', 'local'); S.mode = 'local'; startApp(); });

  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]'); if (!b) return;
    $$('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
    $$('[data-panel]').forEach((p) => p.classList.toggle('show', p.dataset.panel === b.dataset.tab));
    localStorage.setItem('pf_tab', b.dataset.tab);
    requestAnimationFrame(() => { renderChart(); renderHoldings(); renderWatch(); });
  });
  const tab = localStorage.getItem('pf_tab') || 'overview';
  ($(`#tabs [data-tab="${tab}"]`) || $('#tabs button')).click();

  $('#rangeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    S.range = b.dataset.r; localStorage.setItem('pf_range', S.range);
    $$('#rangeSeg button').forEach((x) => x.classList.toggle('on', x === b));
    renderHeader(); renderChart();
  });
  $$('#rangeSeg button').forEach((x) => x.classList.toggle('on', x.dataset.r === S.range));

  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-trade],[data-open-trade],[data-deltx],[data-delwatch],[data-watchadd]');
    if (!t) return;
    if (t.dataset.openTrade) return openTrade(t.dataset.openTrade);
    if (t.dataset.trade) return openTrade(t.dataset.trade, t.dataset.sym);
    if (t.dataset.deltx) {
      const tx = S.tx.find((x) => x.id === t.dataset.deltx);
      if (!confirm(`Eliminare il movimento ${tx.side === 'buy' ? 'di acquisto' : 'di vendita'} di ${num(tx.quantity)} ${tx.symbol}?`)) return;
      try { await store.delTx(tx.id); S.tx = S.tx.filter((x) => x.id !== tx.id); renderAll(); toast('Movimento eliminato'); } catch (err) { toast(err.message); }
    }
    if (t.dataset.delwatch) {
      try { await store.delWatch(t.dataset.delwatch); S.watch = S.watch.filter((x) => x.id !== t.dataset.delwatch); renderWatch(); } catch (err) { toast(err.message); }
    }
    if (t.dataset.watchadd) {
      const s = t.dataset.watchadd;
      try { const w = await store.addWatch({ symbol: s, name: S.uni[s]?.name }); S.watch = S.watch.filter((x) => x.symbol !== s).concat(w); renderWatch(); toast(`${s} aggiunto ai titoli osservati`); } catch (err) { toast(err.message); }
    }
  });

  $$('#sideSeg button').forEach((b) => b.addEventListener('click', () => setSide(b.dataset.side)));
  attachSearch($('#tSymbolSearch'), $('#tSuggest'), prefill);
  $('#tradeForm').addEventListener('submit', (e) => { if (e.submitter?.value === 'cancel') return; saveTrade(e); });

  attachSearch($('#wSymbolSearch'), $('#wSuggest'));
  $('#addWatchBtn').addEventListener('click', () => { $('#watchForm').reset(); $('#wMsg').textContent = ''; $('#wSymbolSearch')._picked = null; $('#watchDlg').showModal(); });
  $('#watchForm').addEventListener('submit', async (e) => {
    if (e.submitter?.value === 'cancel') return;
    e.preventDefault();
    const pick = pickedSymbol($('#wSymbolSearch'));
    if (!pick) return ($('#wMsg').textContent = 'Scegli un titolo.');
    const q = (await fetchQuotes([pick.symbol], '1y').catch(() => ({})))[pick.symbol];
    if (!q) return ($('#wMsg').textContent = `Simbolo "${pick.symbol}" non trovato.`);
    S.uni[q.symbol] = q;
    try {
      const w = await store.addWatch({ symbol: q.symbol, name: q.name, target_price: +$('#wTarget').value || null });
      S.watch = S.watch.filter((x) => x.symbol !== w.symbol).concat(w);
      $('#watchDlg').close(); renderWatch(); toast(`${q.symbol} aggiunto`);
    } catch (err) { $('#wMsg').textContent = err.message; }
  });

  $('#refreshBtn').addEventListener('click', () => refresh());
  $('#menuBtn').addEventListener('click', () => { $('#installHelp').hidden = true; $('#menuDlg').showModal(); });
  $('#installHelpBtn').addEventListener('click', () => ($('#installHelp').hidden = !$('#installHelp').hidden));
  $('#menuDlg a[href="/?view=mini"]').addEventListener('click', (e) => {
    e.preventDefault();
    window.open('/?view=mini', 'pf_mini', 'popup,width=320,height=460');
  });
  $('#logoutBtn').addEventListener('click', async () => {
    if (S.mode === 'local') localStorage.removeItem('pf_mode');
    else await S.db.auth.signOut();
    localStorage.removeItem('pf_cache');
    location.reload();
  });
  $('#runAnalysisBtn').addEventListener('click', () => { $('#menuDlg').close(); runAnalysisNow(); });
  $('#exportBtn').addEventListener('click', () => {
    const rows = [['data', 'operazione', 'simbolo', 'nome', 'quantita', 'prezzo', 'valuta', 'commissioni', 'nota']]
      .concat(sortTx(S.tx).map((t) => [t.trade_date, t.side === 'buy' ? 'acquisto' : 'vendita', t.symbol, t.name, t.quantity, t.price, t.currency, t.fees, t.note || '']));
    const csv = rows.map((r) => r.map((x) => `"${String(x ?? '').replace(/"/g, '""')}"`).join(';')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
    a.download = `movimenti-${today()}.csv`; a.click();
  });
  $('#importLocalBtn').addEventListener('click', async () => {
    const tx = local.get('pf_tx'), wl = local.get('pf_watch');
    if (!confirm(`Importare ${tx.length} movimenti e ${wl.length} titoli osservati nel tuo account?`)) return;
    try {
      if (tx.length) { const { error } = await S.db.from('transactions').insert(tx.map(({ id, created_at, ...r }) => r)); if (error) throw error; }
      for (const { id, ...w } of wl) await store.addWatch(w);
      local.set('pf_tx', []); local.set('pf_watch', []);
      toast('Dati importati'); location.reload();
    } catch (err) { toast(err.message, 5000); }
  });

  // installazione PWA
  let deferred;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; $('#installBtn').hidden = false; });
  $('#installBtn').addEventListener('click', async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $('#installBtn').hidden = true; });
  window.addEventListener('appinstalled', () => { $('#installBtn').hidden = true; toast('App installata'); });

  if ('documentPictureInPicture' in window) {
    $('#pipBtn').hidden = false;
    $('#pipBtn').addEventListener('click', () => openPip().catch((e) => toast(e.message)));
  }

  let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => (MINI ? renderMini($('.mini')) : renderAll()), 150); });
}

/* ---------- avvio ---------- */
(async function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  bind();
  const ok = await setupBackend().catch((e) => { $('#loginMsg').textContent = e.message; return false; });
  if (ok) startApp(); else showLogin();
  S.db?.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_OUT') location.reload(); });
})();
