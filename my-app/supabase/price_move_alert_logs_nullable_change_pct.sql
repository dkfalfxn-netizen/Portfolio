-- 2026-04-21: change_pct 컬럼을 nullable로 변경
-- null = 시세 조회 실패 (중복 발송 방지 로그만 남긴 것), 0 이상 = 실제 등락률
-- Supabase SQL Editor에서 실행하세요.

alter table price_move_alert_logs
  alter column change_pct drop not null,
  alter column change_pct drop default;
