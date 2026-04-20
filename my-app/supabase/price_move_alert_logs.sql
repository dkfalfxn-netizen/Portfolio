-- 텔레그램 등 가격 브리핑 중복 방지 로그 (슬롯별 일중 발송 → briefing_slot 포함 PK)
-- 기존 DB는 price_move_alert_logs_briefing_slot.sql 로 마이그레이션하세요.
create table if not exists price_move_alert_logs (
  sync_key text not null,
  symbol text not null,
  date date not null,
  briefing_slot text not null default 'legacy',
  change_pct double precision not null default 0,
  created_at timestamptz not null default now(),
  primary key (sync_key, symbol, date, briefing_slot)
);

create index if not exists idx_price_move_alert_logs_date on price_move_alert_logs(date desc);

-- 서버(service_role 키)는 RLS를 우회합니다. anon 직접 접근 차단.
alter table price_move_alert_logs enable row level security;
create policy "deny anon" on price_move_alert_logs for all using (false);

