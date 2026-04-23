# 유동성 브리핑 Cron 점검

- **스케줄:** `vercel.json` — `/api/cron/liquidity-briefing` → `0 0 * * *` (UTC) = **한국 09:00 (KST)**.
- **필수 환경 변수:** `CRON_SECRET` (권한), `OPENAI_API_KEY` (AI 요약), Supabase 서비스 키(저장), 선택 `TELEGRAM_*`(알림).
- **정상 동작 확인:** [Vercel] 프로젝트 → Cron → 해당 작업이 매일 “성공”인지, [Supabase] `liquidity_briefings`에 `report_date`가 오늘(한국일)로 한 줄씩 쌓이는지, 대시보드 유동성 탭에 최신 날짜가 보이는지 (차트/AI 요약).

배포 URL에서 수동 호출(관리용):

```http
GET /api/cron/liquidity-briefing
Authorization: Bearer <CRON_SECRET>
```

---

## 연준·금리 뉴스 AI 요약 (macro-fed-briefing)

- **스케줄:** `vercel.json` — `/api/cron/macro-fed-briefing` → `15 0 * * *` (UTC) = **한국 09:15 (KST)** (유동성 Cron 직후).
- **저장소:** Supabase `macro_fed_briefings` — `supabase/macro_fed_briefings.sql` 실행 필요.
- **데이터:** Google 뉴스 RSS 제목만 수집 → OpenAI로 3~4문장 한국어 요약(케빈 워시·연준 정책 언급 시 반영 시도).
- **대시보드:** 유동성 탭 하단 카드에서 조회 (`GET /api/macro/fed-brief`).

```http
GET /api/cron/macro-fed-briefing
Authorization: Bearer <CRON_SECRET>
```
