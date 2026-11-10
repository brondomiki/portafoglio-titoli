# Portafoglio Titoli

App web installabile (PWA) per seguire i propri titoli: grafico verde/rosso, acquisti e vendite, valutazioni automatiche, titoli da osservare con prezzo d'ingresso, widget compatto e finestra flottante sempre in primo piano.

- **Frontend**: HTML/JS senza build (`public/`)
- **API prezzi**: funzioni Vercel (`api/`) che leggono Yahoo Finance (nessuna chiave richiesta)
- **Dati**: Supabase (tabelle `transactions` e `watchlist`, protette da RLS)

## Pubblicazione (10 minuti)

1. **GitHub** – crea un repository vuoto (es. `portafoglio`) e carica il contenuto di questa cartella:
   ```bash
   git init && git add . && git commit -m "Prima versione"
   git branch -M main
   git remote add origin https://github.com/<tuo-utente>/portafoglio.git
   git push -u origin main
   ```
2. **Supabase** – nuovo progetto → *SQL Editor* → incolla `supabase/schema.sql` → *Run*.
   In *Project Settings → API* copia **Project URL** e **anon/publishable key**.
   (Facoltativo) *Authentication → URL Configuration*: imposta come Site URL l'indirizzo Vercel.
3. **Vercel** – *Add New → Project* → importa il repository → *Environment Variables*:
   - `SUPABASE_URL` = Project URL
   - `SUPABASE_ANON_KEY` = anon/publishable key

   → *Deploy*. (In alternativa usa l'integrazione Supabase del Marketplace Vercel: le variabili vengono create in automatico.)
4. Apri l'indirizzo `https://<progetto>.vercel.app`, crea l'account e accedi da PC e telefono con le stesse credenziali.

## Installazione su ogni dispositivo

| Dispositivo | Come |
|---|---|
| Windows / Mac (Chrome, Edge) | Icona *Installa* nella barra indirizzi → tasto destro sull'icona nella barra delle applicazioni → *Aggiungi alla barra delle applicazioni* |
| Android | Chrome → ⋮ → *Installa app* |
| iPhone / iPad | Safari → Condividi → *Aggiungi alla schermata Home* |

**Colpo d'occhio dal desktop**
- Pulsante con i due riquadri (Chrome/Edge desktop): apre una **finestra flottante sempre in primo piano** con totale, variazione e titoli.
- Tasto destro sull'icona dell'app installata → **Widget compatto**: piccola finestra separata, da tenere in un angolo dello schermo.

## Personalizzazione
- Elenco dei titoli suggeriti: costante `UNIVERSE` in `public/app.js` (simboli Yahoo: `.MI` Milano, `.DE` Xetra, `.PA` Parigi, ecc.).
- Logica delle valutazioni: `public/analysis.js`.

> Le valutazioni sono segnali tecnici automatici (medie mobili, RSI, momentum, tendenza) basati sui prezzi passati: non sono consulenza finanziaria e non garantiscono risultati futuri.
