-- 카카오 가격 변동 알림 중복 방지 로그
create table if not exists price_move_alert_logs (
  sync_key text not null,
  symbol text not null,
  date date not null,
  change_pct double precision not null default 0,
  created_at timestamptz not null default now(),
  primary key (sync_key, symbol, date)
);

create index if not exists idx_price_move_alert_logs_date on price_move_alert_logs(date desc);

alter table price_move_alert_logs disable row level security;

