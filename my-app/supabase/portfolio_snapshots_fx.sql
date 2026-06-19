-- Supabase SQL 편집기에서 한 번 실행하세요.
-- 동기화(push) 시점에 대시보드가 사용한 환율을 저장해, 텔레그램 데일리 리포트가
-- 시세를 재조회하지 않고 "대시보드가 본 그 값"을 그대로 재현하도록 합니다.
-- (값이 없으면(마이그레이션 전·환율 미전송) 텔레그램은 기존처럼 라이브 시세로 계산합니다.)

alter table public.portfolio_snapshots
  add column if not exists usd_krw double precision;

alter table public.portfolio_snapshots
  add column if not exists eur_krw double precision;
