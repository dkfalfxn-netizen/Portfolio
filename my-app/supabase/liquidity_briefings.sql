-- ============================================================
-- 유동성 브리핑 시계열 저장 테이블 (09:00 KST 크론용)
-- Supabase SQL Editor에서 실행하세요.
-- ============================================================

create table if not exists liquidity_briefings (
  id uuid primary key default gen_random_uuid(),
  report_date date not null unique,

  net_liquidity numeric,
  net_liquidity_pct numeric,
  walcl numeric,
  tga numeric,
  rrp numeric,

  dxy numeric,
  dxy_pct numeric,
  us10y numeric,
  us10y_pct numeric,

  hy_spread numeric,
  hy_spread_diff_bp numeric,
  vix numeric,
  vix_pct numeric,

  btc numeric,
  btc_pct numeric,
  gold numeric,
  gold_pct numeric,

  ai_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function update_liquidity_briefings_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_liquidity_briefings_updated_at on liquidity_briefings;
create trigger trg_liquidity_briefings_updated_at
before update on liquidity_briefings
for each row execute procedure update_liquidity_briefings_updated_at();

create index if not exists idx_liquidity_briefings_report_date
on liquidity_briefings (report_date desc);

-- 클라이언트(anon/authenticated) 직접 접근을 막기 위해 RLS 활성화.
-- 서버의 service_role 키는 RLS를 우회하므로 Cron/API 저장·조회는 정상 동작합니다.
alter table liquidity_briefings enable row level security;
