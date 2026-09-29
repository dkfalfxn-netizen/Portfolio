# Portfolio — Claude Code 작업 가이드

주식 포트폴리오 대시보드(Next.js + Supabase + Vercel Cron + 텔레그램/카카오 알림). **앱 소스는 `my-app/`** 에 있다.
`my-app/my-app/` 은 예전 템플릿 잔재이므로 **수정 대상이 아니다.** 상세 절차는 `README.md`, 인수인계 메모는 `my-app/HANDOFF.md`.

## 환경 (다른 PC에서도 동일하게)
- Node **22** (`.nvmrc`), 패키지 관리는 **npm** (`package-lock.json` 기준, 다른 매니저 금지).
- 세션 시작 시 `.claude/hooks/session-start.sh` 가 `my-app/node_modules` 가 없거나 lockfile이 바뀌었으면 자동으로 `npm ci` 를 돌린다.
- **비밀값은 Git에 없다.** `my-app/.env.local` 은 직접 만들어야 한다: `my-app/.env.example` 복사 후 채우거나, Vercel 프로젝트 연결 후 `npx vercel env pull .env.local`. `.env*` 는 읽기·커밋 금지.
- 사용자 데이터(보유종목 등)는 브라우저 `localStorage` + Supabase(동기화 키)에 있다. 새 환경에서 비어 있는 건 정상이며, 앱의 서버 동기화(Pull)로 복구한다.

## 명령어 (저장소 루트 또는 `my-app/`)
| 목적 | 명령 |
|---|---|
| 개발 서버 | `npm run dev` (루트) / `my-app`에서 `npm run dev` |
| 타입 검사 | `cd my-app && npx tsc --noEmit` |
| 린트 | `cd my-app && npx eslint app components lib` |
| 빌드 | `npm run build` |
| 배포 | `npm run deploy` (빌드 → 커밋 → 푸시. **사용자가 요청할 때만**) |

린트 기준선(`npx eslint app components lib`): 기존 **오류 1개(rebalancing-calculator) · 경고 21개**. 이보다 늘리지 않는다.

## 작업 원칙
1. **데이터 손상 방지가 최우선.** `localStorage` 키(`portfolio_*_v1` 등)·Supabase 스키마·동기화(`/api/sync`) 페이로드 형식은 명시적 요청 없이 바꾸지 않는다. 큰 변경 전에는 `backup-*` 브랜치를 먼저 만든다.
2. **리팩터링은 동작 불변**이 원칙: 코드 본문은 그대로 옮기고, 이동 전후 `tsc`·`eslint`·`next build` 결과를 비교한다.
3. 코드를 수정하면 끝내기 전에 검증한다: 변경 범위 확인 → tsc/eslint(가능하면 build) → 텔레그램/카카오 알림 포맷·발송 로직 회귀 여부 확인 → 남은 위험을 보고(심각도 순, 발견사항 먼저).
4. 작업이 끝나면 관련 변경만 `git add` → 한 줄 커밋 → 현재 브랜치 push. (WIP·실험이라고 하거나 커밋하지 말라고 하면 제외.) PR은 요청 시에만 만든다.
5. 사용자와는 **한국어**로 소통한다. 커밋 메시지는 한국어 또는 conventional commit.
6. Next.js 버전이 학습 지식과 다르다. 코드 작성 전 `my-app/node_modules/next/dist/docs/` 를 확인한다 (`my-app/AGENTS.md`).

## 코드 구조 메모
- `my-app/app/page.tsx` — 대시보드 본체(`Home()`, 여전히 큼). 점진적으로 분리 중. 섹션 컴포넌트(`components/watchlist-section.tsx`, `telegram-alert-section.tsx`, `sync-section.tsx`)는 상태를 Home이 갖고 props로 받는다.
- 분리된 모듈: `lib/portfolio-types.ts`(타입·저장 키 상수), `portfolio-storage.ts`(localStorage 로드/저장), `portfolio-positions.ts`(포지션 병합·파싱), `portfolio-sync-helpers.ts`(서버 pull 검증·충돌 판단), `portfolio-seed.ts`, `portfolio-calc.ts`(매도 실현손익·매입 현금 차감), `portfolio-holdings-helpers.ts`, `broker-notification-parser.ts`(증권사 체결 알림 파서).
- `app/api/**` — 동기화·시세·크론·알림 라우트. 크론 스케줄은 `vercel.json`.
- `supabase/*.sql` — 테이블 정의(신규 환경에서 순서대로 실행).
