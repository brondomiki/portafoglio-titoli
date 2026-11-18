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
let live = [];        // riferimenti alle frasi in coda (senza, Chrome può perdere gli eventi di fine)
let watchdog = null;  // controlla che la voce stia davvero parlando
let idleSince = 0, retries = 0, doneIdx = -1, startedIdx = -1; // ultima frase completata / iniziata
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
    .replace(/\d{1,3}(?:\.\d{3})+(?=,\d|\D|$)/g, (m) => m.replace(/\./g, '')) // separatore delle migliaia
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
// l'audio muto (necessario per i tasti del volante) su alcuni telefoni zittisce la voce: solo su richiesta
export const wheelKeysEnabled = () => { try { return localStorage.getItem('pf_wheel') === '1'; } catch { return false; } };
export function setWheelKeys(on) {
  try { localStorage.setItem('pf_wheel', on ? '1' : '0'); } catch {}
  if (!on && silent) silent.pause();
  updateMediaSession();
}
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
  if (wheelKeysEnabled()) {
    const a = silentAudio();
    if (current && !isPaused) { if (a.paused) a.play().catch(() => {}); }
    else a.pause();
  } else if (silent && !silent.paused) silent.pause();
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
  pos = Math.max(0, Math.min(from, queue.length - 1));
  isPaused = false;
  idleSince = 0;
  keepAwake();
  startWatchdog();
  emit();
  const busy = synth.speaking || synth.pending;
  if (busy) {
    synth.cancel();
    // Chrome su Android ignora le frasi accodate subito dopo un annullamento: breve attesa
    setTimeout(() => { if (g === gen) enqueue(g, pos); }, 150);
  } else enqueue(g, pos); // subito, dentro il tocco dell'utente (necessario su iPhone)
}
function enqueue(g, from) {
  try { synth.resume(); } catch {}
  const rate = +(localStorage.getItem('pf_rate') || 1.05);
  live = [];
  for (let i = from; i < queue.length; i++) {
    const u = new SpeechSynthesisUtterance(queue[i].text);
    u.lang = 'it-IT';
    if (voice) u.voice = voice;
    u.rate = rate;
    u.onstart = () => { if (g === gen) { pos = i; startedIdx = Math.max(startedIdx, i); emit(); } };
    u.onend = () => { if (g !== gen) return; doneIdx = Math.max(doneIdx, i); retries = 0; if (i === queue.length - 1) finish(); };
    u.onerror = (e) => { if (g === gen && e.error !== 'interrupted' && e.error !== 'canceled') finish(); };
    live.push(u);
    synth.speak(u);
  }
}

// se il sistema interrompe la voce senza avvisare, riprende dalla frase corrente; se non riesce, si ferma
function startWatchdog() {
  if (watchdog) return;
  watchdog = setInterval(() => {
    if (!current) { clearInterval(watchdog); watchdog = null; return; }
    if (isPaused || document.visibilityState === 'hidden') { idleSince = 0; return; }
    if (synth.speaking || synth.pending) { idleSince = 0; return; }
    if (!idleSince) { idleSince = Date.now(); return; }
    if (Date.now() - idleSince < 2000) return;
    idleSince = 0;
    if (doneIdx >= queue.length - 1 || startedIdx >= queue.length - 1) return finish(); // conclusa, evento di fine perso
    if (++retries > 2) return finish();                 // la voce non riparte: libera i pulsanti
    playFrom(Math.max(pos, doneIdx + 1));               // riprende dalla prima frase non completata
  }, 700);
}
function finish() {
  gen++;
  live = []; retries = 0; idleSince = 0; doneIdx = -1; startedIdx = -1;
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
  startedIdx = doneIdx = -1;
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
  startedIdx = doneIdx = i - 1;
  playFrom(i);
}
export function prevSection() {
  if (!current) return;
  const part = queue[pos]?.part ?? 0;
  const start = queue.findIndex((q) => q.part === part);
  // se si è appena iniziata la sezione, torna a quella precedente
  const to = pos - start < 1 && part > 0 ? queue.findIndex((q) => q.part === part - 1) : start;
  startedIdx = doneIdx = to - 1;
  playFrom(to);
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
