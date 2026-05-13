-- 기존 테이블에 리밸 계산기 스냅샷 컬럼 추가 (동기화 서버 우선 저장용)
alter table public.portfolio_snapshots
  add column if not exists rebalance_calculator_by_owner jsonb not null default '{}'::jsonb;
