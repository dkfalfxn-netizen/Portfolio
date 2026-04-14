-- 텔레그램 일중 브리핑: 하루 여러 번(슬롯별) 발송을 위해 PK에 briefing_slot 추가
-- Supabase SQL 편집기에서 한 번 실행하세요. (기존 price_move_alert_logs 가 있을 때)

ALTER TABLE public.price_move_alert_logs
  ADD COLUMN IF NOT EXISTS briefing_slot text NOT NULL DEFAULT 'legacy';

UPDATE public.price_move_alert_logs SET briefing_slot = 'legacy' WHERE briefing_slot = '';

ALTER TABLE public.price_move_alert_logs DROP CONSTRAINT IF EXISTS price_move_alert_logs_pkey;

ALTER TABLE public.price_move_alert_logs
  ADD PRIMARY KEY (sync_key, symbol, date, briefing_slot);
