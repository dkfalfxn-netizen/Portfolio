-- Supabase SQL 편집기에서 한 번 실행하세요.
-- 관심종목(텔레그램 MA·RSI·BB·VOL 시그널용)을 sync_key별로 저장합니다.

alter table public.portfolio_snapshots
  add column if not exists watchlist jsonb not null default '[]'::jsonb;

comment on column public.portfolio_snapshots.watchlist is
  '관심종목 배열: [{"symbol":"005930","name":"삼성전자"}, ...]';
