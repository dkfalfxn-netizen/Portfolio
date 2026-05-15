-- portfolio_snapshots 에 보유 종목별 기준선(가격·수익률 %) JSON 을 추가합니다.
-- Supabase SQL 편집기에서 기존 DB에 한 번 실행하세요.
alter table public.portfolio_snapshots
  add column if not exists alert_thresholds_by_position jsonb not null default '{}'::jsonb;

comment on column public.portfolio_snapshots.alert_thresholds_by_position is
  '보유 종목 기준선: 키 "보유자::티커" → { takeProfitPrice, stopLossPrice, takeProfitReturnPct, stopLossReturnPct }';
