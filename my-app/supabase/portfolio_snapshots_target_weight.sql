-- Supabase: 목표 주식 비중(보유자별)을 잔고 스냅샷에 함께 보관
-- (기존 portfolio_snapshots.sql 이후에 한 번 실행)
alter table public.portfolio_snapshots
  add column if not exists target_stock_weight_by_owner jsonb not null default '{}'::jsonb;
