// Lettura ad alta voce (sintesi vocale del browser, in italiano). Nessun servizio esterno.

const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
export const speechSupported = !!synth && typeof SpeechSynthesisUtterance !== 'undefined';

let voice = null;
let queue = [];      // frasi della lettura in corso
let pos = 0;         // frase in lettura
let wakeLock = null; // tiene lo schermo acceso durante la lettura
let paused = null;   // lettura interrotta dal blocco del telefono: { id, queue, pos }
let current = null; // id del pulsante che sta leggendo
const listeners = new Set();
export const onSpeechChange = (fn) => listeners.add(fn);
const emit = () => listeners.forEach((fn) => fn(current));

function pickVoice() {
  if (!speechSupported) return null;
  const vs = synth.getVoices().filter((v) => v.lang?.toLowerCase().startsWith('it'));
  const pref = ['natural', 'neural', 'google', 'elsa', 'alice', 'federica', 'isabella', 'diego', 'luca'];
  for (const p of pref) { const v = vs.find((x) => x.name.toLowerCase().includes(p)); if (v) return v; }
  return vs[0] || null;
}
if (speechSupported) {
  voice = pickVoice();
  synth.addEventListener?.('voiceschanged', () => { voice = pickVoice(); });
}

// rende pronunciabili numeri, percentuali, segni e simboli
export function sayable(text) {
  return String(text)
    .replace(/(\d)\.(\d)/g, '$1,$2')
    .replace(/([+−-])\s?(\d[\d.,]*)\s?%/g, (_, s, n) => `${s === '+' ? 'più' : 'meno'} ${n} per cento`)
    .replace(/(\d[\d.,]*)\s?%/g, '$1 per cento')
    .replace(/([+−-])\s?(\d[\d.,]*)\s?€/g, (_, s, n) => `${s === '+' ? 'più' : 'meno'} ${n} euro`)
    .replace(/€\s?(\d[\d.,]*)/g, '$1 euro')
    .replace(/(\d[\d.,]*)\s?€/g, '$1 euro')
    .replace(/\$\s?(\d[\d.,]*)|(\d[\d.,]*)\s?(USD|\$)/g, (_, a, b) => `${a || b} dollari`)
    .replace(/\bEUR\b/g, 'euro')
    .replace(/\bRSI\b/g, 'R S I')
    .replace(/≤/g, 'sotto')
    .replace(/·/g, ',')
    .replace(/[–—]/g, ', ')
    .replace(/→/g, ' a ')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- schermo sempre acceso durante la lettura (Screen Wake Lock API) ---
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && !wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { wakeLock = null; }
}
function releaseAwake() { try { wakeLock?.release(); } catch {} wakeLock = null; }

function finish(id) {
  if (current !== id) return;
  current = null; queue = []; pos = 0;
  releaseAwake();
  emit();
}

export function stopSpeaking() {
  if (!speechSupported) return;
  paused = null;
  synth.cancel();
  current = null; queue = []; pos = 0;
  releaseAwake();
  emit();
}

function playFrom(id, from) {
  const rate = +(localStorage.getItem('pf_rate') || 1.05);
  for (let i = from; i < queue.length; i++) {
    const u = new SpeechSynthesisUtterance(queue[i]);
    u.lang = 'it-IT';
    if (voice) u.voice = voice;
    u.rate = rate;
    u.onstart = () => { if (current === id) pos = i; };
    if (i === queue.length - 1) u.onend = () => finish(id);
    u.onerror = (e) => { if (e.error !== 'interrupted' && e.error !== 'canceled') finish(id); };
    synth.speak(u);
  }
}

// se il telefono viene bloccato a mano la lettura si interrompe: riprende da dove era rimasta alla riaccensione
if (speechSupported && typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && current) {
      paused = { id: current, queue: [...queue], pos };
    } else if (document.visibilityState === 'visible') {
      if (paused) {
        const p = paused; paused = null;
        synth.cancel();
        current = p.id; queue = p.queue; pos = p.pos;
        emit();
        keepAwake();
        setTimeout(() => playFrom(p.id, p.pos), 300);
      } else if (current) keepAwake();
    }
  });
}

// legge un elenco di frasi; id identifica il pulsante (premuto di nuovo = stop)
export function speak(parts, id) {
  if (!speechSupported) return false;
  if (current === id) { stopSpeaking(); return true; }
  synth.cancel();
  paused = null;
  current = id;
  emit();
  keepAwake();
  // frasi brevi: evita che Chrome interrompa le letture lunghe
  queue = parts.flatMap((p) => sayable(p).split(/(?<=[.!?])\s+/)).filter(Boolean);
  pos = 0;
  playFrom(id, 0);
  return true;
}

export const isSpeaking = (id) => current === id;
