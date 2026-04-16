-- Supabase SQL 편집기에서 한 번 실행하세요.
create table if not exists public.portfolio_snapshots (
  sync_key text primary key,
  positions jsonb not null default '[]'::jsonb,
  cash_by_owner jsonb not null default '{}'::jsonb,
  holdings_sort_by_owner jsonb not null default '{}'::jsonb,
  owner_names jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.portfolio_snapshots
  add column if not exists owner_names jsonb not null default '[]'::jsonb;

alter table public.portfolio_snapshots enable row level security;

-- 서비스 롤(API Route)은 RLS를 우회합니다. anon 직접 접근은 막습니다.
create policy "deny anon" on public.portfolio_snapshots for all using (false);
