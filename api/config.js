// Restituisce al browser URL e chiave pubblica di Supabase lette dalle variabili d'ambiente di Vercel.
// (La chiave "anon"/"publishable" è pensata per stare nel browser: i dati sono protetti dalle regole RLS.)
export default function handler(req, res) {
  const env = process.env;
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    url: env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || '',
    key:
      env.SUPABASE_ANON_KEY ||
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      env.SUPABASE_PUBLISHABLE_KEY ||
      env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
      ''
  });
}
