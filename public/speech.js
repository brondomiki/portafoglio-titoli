// Lettura ad alta voce (sintesi vocale del browser, in italiano). Nessun servizio esterno.

const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
export const speechSupported = !!synth && typeof SpeechSynthesisUtterance !== 'undefined';

let voice = null;
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

export function stopSpeaking() {
  if (!speechSupported) return;
  synth.cancel();
  current = null;
  emit();
}

// legge un elenco di frasi; id identifica il pulsante (premuto di nuovo = stop)
export function speak(parts, id) {
  if (!speechSupported) return false;
  if (current === id) { stopSpeaking(); return true; }
  synth.cancel();
  current = id;
  emit();
  // frasi brevi: evita che Chrome interrompa le letture lunghe
  const chunks = parts.flatMap((p) => sayable(p).split(/(?<=[.!?])\s+/)).filter(Boolean);
  const rate = +(localStorage.getItem('pf_rate') || 1.05);
  chunks.forEach((c, i) => {
    const u = new SpeechSynthesisUtterance(c);
    u.lang = 'it-IT';
    if (voice) u.voice = voice;
    u.rate = rate;
    if (i === chunks.length - 1) u.onend = () => { if (current === id) { current = null; emit(); } };
    u.onerror = (e) => { if (e.error !== 'interrupted' && e.error !== 'canceled' && current === id) { current = null; emit(); } };
    synth.speak(u);
  });
  return true;
}

export const isSpeaking = (id) => current === id;
