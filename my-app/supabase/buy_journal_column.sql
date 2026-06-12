-- Supabase SQL 편집기에서 한 번 실행하세요.
-- 매수저널(매수 기록: 매수일·수량·단가·환율)을 sync_key별로 저장합니다.
-- 이전에는 기기 localStorage에만 있어 다른 기기에서 보이지 않고,
-- 기기 분실·브라우저 데이터 삭제 시 기록이 영구 소실되는 문제가 있었습니다.

alter table public.portfolio_snapshots
  add column if not exists buy_journal jsonb not null default '[]'::jsonb;

comment on column public.portfolio_snapshots.buy_journal is
  '매수저널 배열: [{"id":"...","date":"2026-06-12","owner":"김승주","symbol":"AAPL","name":"애플","qty":1,"buyPrice":200,"currency":"USD","fxRate":1380,"totalKrw":276000,"fxPending":false}, ...]';
