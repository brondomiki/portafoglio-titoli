// Lettura ad alta voce (sintesi vocale del browser, in italiano). Nessun servizio esterno.
// Supporta: sezioni (avanti/indietro), pausa/ripresa, schermo sempre acceso,
// ripresa dopo il blocco del telefono e comandi multimediali (volante / Bluetooth dell'auto).

const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
export const speechSupported = !!synth && typeof SpeechSynthesisUtterance !== 'undefined';

let voice = null;
let queue = [];       // [{ text, part }] frasi della lettura in corso
let pos = 0;          // frase in lettura
let current = null;   // id della lettura in corso
let isPaused = false; // in pausa (dall'utente o per blocco del telefono)
let wakeLock = null;
let gen = 0;          // invalida i callback delle letture annullate
const listeners = new Set();
export const onSpeechChange = (fn) => listeners.add(fn);
const emit = () => { listeners.forEach((fn) => fn(state())); updateMediaSession(); };
export const state = () => ({ id: current, paused: isPaused, text: queue[pos]?.text || '', pos, total: queue.length, part: queue[pos]?.part ?? 0 });
export const isSpeaking = (id) => current === id && !isPaused;
export const isActive = (id) => current === id;

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
    .replace(/\s*·\s*/g, ', ')
    .replace(/[–—]/g, ', ')
    .replace(/→/g, ' a ')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- schermo sempre acceso durante la lettura ---
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && !wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { wakeLock = null; }
}
function releaseAwake() { try { wakeLock?.release(); } catch {} wakeLock = null; }

// --- comandi multimediali: audio muto in sottofondo rende attivi i tasti del volante / Bluetooth ---
let silent = null;
function silentAudio() {
  if (silent) return silent;
  // 1 secondo di silenzio WAV (8 kHz, 8 bit)
  const n = 8000, buf = new Uint8Array(44 + n), dv = new DataView(buf.buffer);
  const w = (o, s) => [...s].forEach((c, i) => (buf[o + i] = c.charCodeAt(0)));
  w(0, 'RIFF'); dv.setUint32(4, 36 + n, true); w(8, 'WAVEfmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 8000, true); dv.setUint32(28, 8000, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true); w(36, 'data'); dv.setUint32(40, n, true);
  buf.fill(128, 44);
  silent = new Audio(URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })));
  silent.loop = true; silent.volume = 0.01;
  return silent;
}
let mediaEnabled = false;
let mediaTitle = 'Portafoglio';
export function enableMediaControls(title = 'Portafoglio') {
  mediaEnabled = true; mediaTitle = title;
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  const set = (a, f) => { try { ms.setActionHandler(a, f); } catch {} };
  set('play', () => resumeSpeaking());
  set('pause', () => pauseSpeaking());
  set('stop', () => stopSpeaking());
  set('nexttrack', () => nextSection());
  set('previoustrack', () => prevSection());
  set('seekforward', () => nextSection());
  set('seekbackward', () => prevSection());
}
function updateMediaSession() {
  if (!mediaEnabled) return;
  const a = silentAudio();
  if (current && !isPaused) a.play().catch(() => {});
  else if (!current) a.pause();
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: queue[pos]?.text?.slice(0, 80) || mediaTitle,
        artist: mediaTitle,
        album: 'Valutazioni',
        artwork: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }]
      });
      navigator.mediaSession.playbackState = current ? (isPaused ? 'paused' : 'playing') : 'none';
    } catch {}
  }
}

// --- lettura ---
function playFrom(from) {
  const g = ++gen;
  synth.cancel();
  const rate = +(localStorage.getItem('pf_rate') || 1.05);
  pos = Math.max(0, Math.min(from, queue.length - 1));
  isPaused = false;
  keepAwake();
  emit();
  for (let i = pos; i < queue.length; i++) {
    const u = new SpeechSynthesisUtterance(queue[i].text);
    u.lang = 'it-IT';
    if (voice) u.voice = voice;
    u.rate = rate;
    u.onstart = () => { if (g === gen) { pos = i; emit(); } };
    if (i === queue.length - 1) u.onend = () => { if (g === gen) finish(); };
    u.onerror = (e) => { if (g === gen && e.error !== 'interrupted' && e.error !== 'canceled') finish(); };
    synth.speak(u);
  }
}
function finish() {
  gen++;
  current = null; queue = []; pos = 0; isPaused = false;
  releaseAwake();
  emit();
}

// parts: elenco di sezioni (stringhe o array di stringhe). id identifica la lettura: premuto di nuovo = stop
export function speak(parts, id, { toggle = true } = {}) {
  if (!speechSupported) return false;
  if (toggle && current === id) { stopSpeaking(); return true; }
  current = id;
  queue = parts.flatMap((p, part) => [].concat(p).flatMap((t) => sayable(t).split(/(?<=[.!?])\s+/)).filter(Boolean).map((text) => ({ text, part })));
  if (!queue.length) { finish(); return false; }
  playFrom(0);
  return true;
}
export function stopSpeaking() {
  if (!speechSupported) return;
  synth.cancel();
  finish();
}
export function pauseSpeaking() {
  if (!current || isPaused) return;
  gen++; synth.cancel(); isPaused = true; releaseAwake(); emit();
}
export function resumeSpeaking() {
  if (!current) return;
  if (isPaused) playFrom(pos);
}
export function togglePause() { if (!current) return; isPaused ? resumeSpeaking() : pauseSpeaking(); }
export function nextSection() {
  if (!current) return;
  const part = queue[pos]?.part ?? 0;
  const i = queue.findIndex((q) => q.part > part);
  if (i === -1) return stopSpeaking();
  playFrom(i);
}
export function prevSection() {
  if (!current) return;
  const part = queue[pos]?.part ?? 0;
  const start = queue.findIndex((q) => q.part === part);
  // se si è appena iniziata la sezione, torna a quella precedente
  if (pos - start < 1 && part > 0) playFrom(queue.findIndex((q) => q.part === part - 1));
  else playFrom(start);
}

// telefono bloccato a mano o app in secondo piano: pausa, poi ripresa dalla stessa frase
if (speechSupported && typeof document !== 'undefined') {
  let autoPaused = false;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && current && !isPaused && !mediaEnabled) {
      autoPaused = true; pauseSpeaking();
    } else if (document.visibilityState === 'visible') {
      if (autoPaused && current && isPaused) setTimeout(() => resumeSpeaking(), 300);
      else if (current && !isPaused) { // lettura interrotta dal sistema mentre era nascosta
        if (!synth.speaking) setTimeout(() => playFrom(pos), 300);
        keepAwake();
      }
      autoPaused = false;
    }
  });
}
