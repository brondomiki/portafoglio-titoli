-- Esegui questo script in Supabase: SQL Editor → New query → incolla → Run

-- Movimenti (acquisti e vendite)
create table if not exists public.transactions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  symbol      text not null,
  name        text,
  side        text not null check (side in ('buy', 'sell')),
  quantity    numeric not null check (quantity > 0),
  price       numeric not null check (price >= 0),
  fees        numeric not null default 0 check (fees >= 0),
  currency    text,
  trade_date  date not null default current_date,
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists transactions_user_idx on public.transactions (user_id, trade_date);

-- Titoli da tenere sotto osservazione
create table if not exists public.watchlist (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  symbol       text not null,
  name         text,
  target_price numeric,
  note         text,
  created_at   timestamptz not null default now(),
  unique (user_id, symbol)
);

-- Sicurezza: ogni utente vede e modifica solo i propri dati
alter table public.transactions enable row level security;
alter table public.watchlist    enable row level security;

drop policy if exists "tx_own" on public.transactions;
create policy "tx_own" on public.transactions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "wl_own" on public.watchlist;
create policy "wl_own" on public.watchlist
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Analisi programmate (mattina e pomeriggio), scritte dal server con la chiave service_role
create table if not exists public.analysis_runs (
  id      bigint generated always as identity primary key,
  run_at  timestamptz not null default now(),
  slot    text not null,
  data    jsonb not null
);
create index if not exists analysis_runs_run_at_idx on public.analysis_runs (run_at desc);
alter table public.analysis_runs enable row level security;
drop policy if exists "analysis_read" on public.analysis_runs;
create policy "analysis_read" on public.analysis_runs for select to anon, authenticated using (true);
