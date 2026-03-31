-- ============================================================
-- AI 데일리 마켓 인사이트 리포트 테이블
-- Supabase SQL Editor에서 실행하세요.
-- ============================================================

create table if not exists market_reports (
  id            uuid        primary key default gen_random_uuid(),

  -- 리포트 날짜 (KST 기준 YYYY-MM-DD). 하루 1건만 저장 → UNIQUE
  report_date   date        not null unique,

  -- 분석에 사용한 영상 목록
  -- [{ channel, channel_id, title, video_id, transcript_chars }]
  videos_analyzed jsonb     not null default '[]',

  -- 오늘의 핵심 매크로/기업 이슈 3가지
  -- [{ title, summary, impact: "high"|"medium"|"low", source_channel }]
  macro_issues  jsonb       not null default '[]',

  -- 내 보유 종목 분석
  -- [{ symbol, name, owner, mentioned, sentiment, key_points[], strategy }]
  portfolio_analysis jsonb  not null default '[]',

  -- 전체 시장 매수/매도 의견
  -- { overall: "bullish"|"bearish"|"neutral", comment,
  --   buy_candidates[], sell_candidates[], watch_list[] }
  buy_sell_opinion jsonb    not null default '{}',

  -- 향후 1~3개월 유망 섹터
  -- [{ sector, sector_key, reason, timeframe, confidence: "high"|"medium"|"low" }]
  future_sectors jsonb      not null default '[]',

  -- 메타데이터
  model_used    text,                         -- 사용한 AI 모델 이름
  prompt_tokens int,                          -- 입력 토큰 수
  completion_tokens int,                      -- 출력 토큰 수
  analysis_duration_ms int,                   -- 분석 소요 시간(ms)
  error_channels jsonb default '[]',          -- 자막 수집 실패한 채널 목록

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- updated_at 자동 갱신 트리거
create or replace function update_market_reports_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_market_reports_updated_at on market_reports;
create trigger trg_market_reports_updated_at
  before update on market_reports
  for each row execute procedure update_market_reports_updated_at();

-- 최신 리포트 빠른 조회용 인덱스
create index if not exists idx_market_reports_date
  on market_reports (report_date desc);

-- ============================================================
-- Row Level Security (서비스 롤 키만 쓸 것이므로 RLS 비활성화)
-- ============================================================
alter table market_reports disable row level security;

-- ============================================================
-- 사용 예시 (Supabase SQL Editor에서 확인용)
-- ============================================================
-- 최신 리포트 1건 조회:
--   select * from market_reports order by report_date desc limit 1;
--
-- 특정 날짜 리포트:
--   select * from market_reports where report_date = '2026-03-31';
--
-- 보유 종목 분석만 추출:
--   select report_date,
--          jsonb_array_elements(portfolio_analysis) as item
--   from market_reports
--   order by report_date desc limit 1;
