// Restituisce al browser URL e chiave pubblica di Supabase lette dalle variabili d'ambiente di Vercel.
// (La chiave "anon"/"publishable" è pensata per stare nel browser: i dati sono protetti dalle regole RLS.)
export default function handler(req, res) {
  const env = process.env;
  res.setHeader('Cache-Control', 'no-store');
  // accetta anche URL incollati con percorsi in coda (es. .../rest/v1/) e tiene solo https://xxxx.supabase.co
  let url = (env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || '').trim();
  try { if (url) url = new URL(url.startsWith('http') ? url : `https://${url}`).origin; } catch { url = ''; }
  res.status(200).json({
    url,
    key: (
      env.SUPABASE_ANON_KEY ||
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      env.SUPABASE_PUBLISHABLE_KEY ||
      env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
      ''
    ).trim()
  });
}
