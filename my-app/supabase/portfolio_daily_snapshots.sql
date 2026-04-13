-- Supabase SQL 편집기에서 한 번 실행하세요.
-- 일별 자산 스냅샷: Vercel Cron이 매일 기록합니다.

CREATE TABLE IF NOT EXISTS public.portfolio_daily_snapshots (
  sync_key   text    NOT NULL REFERENCES public.portfolio_snapshots(sync_key) ON DELETE CASCADE,
  date       date    NOT NULL,
  owner_values jsonb NOT NULL DEFAULT '{}',   -- { "김승주": 12345678, ... }
  breakdown_values jsonb,                     -- { "김승주 · GOLD": 1234, "김승주 · 현금": 5678, ... }
  total_value  numeric NOT NULL DEFAULT 0,
  usd_krw      numeric,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sync_key, date)
);

-- 기존 테이블 업그레이드(이미 있으면 무시)
ALTER TABLE public.portfolio_daily_snapshots
  ADD COLUMN IF NOT EXISTS breakdown_values jsonb;

ALTER TABLE public.portfolio_daily_snapshots ENABLE ROW LEVEL SECURITY;

-- 서비스 롤(API Route)은 RLS를 우회합니다. anon 직접 접근은 막습니다.
CREATE POLICY "deny anon" ON public.portfolio_daily_snapshots FOR ALL USING (false);
