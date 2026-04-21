alter table public.portfolio_snapshots
  add column if not exists sell_log_by_owner jsonb not null default '{}'::jsonb;
