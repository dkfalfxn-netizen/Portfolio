-- Supabase: 보유자별 메모(목표 비중 패널 왼쪽 노트 등)를 잔고 스냅샷에 함께 보관
-- (portfolio_snapshots.sql 또는 target_weight 마이그레이션 이후 한 번 실행)
alter table public.portfolio_snapshots
  add column if not exists owner_scratchpad_by_owner jsonb not null default '{}'::jsonb;
