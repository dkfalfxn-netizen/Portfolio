-- portfolio_daily_snapshots 테이블에 updated_at 컬럼 추가 (LWW 동기화용)
-- Supabase SQL 편집기에서 한 번 실행하세요.

ALTER TABLE public.portfolio_daily_snapshots
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- upsert 시 updated_at 자동 갱신 트리거
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_daily_snapshots_updated_at ON public.portfolio_daily_snapshots;
CREATE TRIGGER trg_daily_snapshots_updated_at
  BEFORE INSERT OR UPDATE ON public.portfolio_daily_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
