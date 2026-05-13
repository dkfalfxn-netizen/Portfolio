-- Supabase SQL 편집기에서 한 번 실행하세요.
create table if not exists public.portfolio_snapshots (
  sync_key text primary key,
  positions jsonb not null default '[]'::jsonb,
  cash_by_owner jsonb not null default '{}'::jsonb,
  holdings_sort_by_owner jsonb not null default '{}'::jsonb,
  owner_names jsonb not null default '[]'::jsonb,
  sell_log_by_owner jsonb not null default '{}'::jsonb,
  target_stock_weight_by_owner jsonb not null default '{}'::jsonb,
  owner_scratchpad_by_owner jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- 기존 테이블에 누락된 컬럼을 추가합니다 (이미 있으면 무시).
alter table public.portfolio_snapshots
  add column if not exists owner_names jsonb not null default '[]'::jsonb;

alter table public.portfolio_snapshots
  add column if not exists sell_log_by_owner jsonb not null default '{}'::jsonb;

alter table public.portfolio_snapshots
  add column if not exists target_stock_weight_by_owner jsonb not null default '{}'::jsonb;

alter table public.portfolio_snapshots
  add column if not exists owner_scratchpad_by_owner jsonb not null default '{}'::jsonb;

alter table public.portfolio_snapshots
  add column if not exists rebalance_calculator_by_owner jsonb not null default '{}'::jsonb;

alter table public.portfolio_snapshots enable row level security;

-- 서비스 롤(API Route)은 RLS를 우회합니다. anon 직접 접근은 막습니다.
create policy "deny anon" on public.portfolio_snapshots for all using (false);
