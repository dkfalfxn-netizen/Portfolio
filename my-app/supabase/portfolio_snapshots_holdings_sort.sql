-- 기존 DB에 한 번 실행: 보유 종목 정렬 모드 동기화용 컬럼
alter table public.portfolio_snapshots
  add column if not exists holdings_sort_by_owner jsonb not null default '{}'::jsonb;
