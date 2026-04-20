# HANDOFF (2026-04-21)

이 문서는 다른 PC/계정/클라우드 환경에서 같은 상태로 이어서 작업하기 위한 체크리스트입니다.

## 1) 현재 저장 상태
- 브랜치: `main`
- 원격 반영: 완료 (`origin/main`)
- 최근 핵심 커밋
  - `1020bb2` refactor: Suggestion 6개 항목 개선
  - `a90a009` fix: Important 8개 항목 개선
  - `698b379` fix: 보안·안정성 4개 항목 개선

## 2) 새 환경에서 시작
1. 저장소 클론
   - `git clone https://github.com/dkfalfxn-netizen/Portfolio.git`
2. 앱 폴더 이동
   - `cd Portfolio/my-app`
3. 의존성 설치
   - `npm install`
4. 환경변수 설정
   - `.env.example` 참고하여 `.env` 생성
5. 실행
   - `npm run dev`

## 3) 반드시 확인할 환경변수
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `CRON_SECRET`
- `TELEGRAM_ALERT_SYNC_KEY`

## 4) Supabase SQL 반영 체크
다음 SQL 파일들이 DB에 반영돼 있어야 동일 동작합니다.
- `supabase/liquidity_briefings.sql`
- `supabase/market_reports.sql`
- `supabase/price_move_alert_logs.sql`
- `supabase/price_move_alert_logs_nullable_change_pct.sql`
- `supabase/portfolio_daily_snapshots.sql`

## 5) 배포 후 확인 포인트
- Vercel Cron이 `vercel.json` 스케줄대로 등록되어 있는지
- `CRON_SECRET`이 Vercel Environment Variables에 설정되어 있는지
- Supabase에서 최근 날짜 기준으로 아래 테이블에 데이터가 쌓이는지
  - `liquidity_briefings`
  - `portfolio_daily_snapshots`
  - `price_move_alert_logs`

## 6) 참고
- 날짜 유틸은 `lib/date-utils.ts`로 통일됨 (`todayKST`, `yesterdayKST`, `mmddKST`)
- 대형 `app/page.tsx` 일부는 섹션 컴포넌트로 분리됨
  - `components/liquidity-section.tsx`
  - `components/simulator-section.tsx`
