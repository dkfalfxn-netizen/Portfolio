# Portfolio

주식 포트폴리오·동기화·알림이 포함된 Next.js 앱입니다. **앱 소스는 `my-app/`** 에 있습니다.

## 다른 PC·새 환경에서 이어하기

### 0. 한눈에 체크리스트

1. **Git** 으로 이 저장소를 받고 (`git clone` … `cd Portfolio`) **의존성 설치** (`npm install --prefix my-app`).
2. **`my-app/.env.local`** 생성 — 아래 [환경 변수](#4-환경-변수-필수) 참고. 예전 PC의 `.env.local` 복사 또는 Vercel 환경 변수 복사.
3. **Supabase** 를 새로 쓰는 경우(또는 테이블이 없을 때) [Supabase SQL 한 번 실행](#9-supabase-테이블-신규-프로젝트) 순서를 따릅니다.
4. **에디터**에서 워크스페이스 루트는 **`Portfolio`** (클론한 폴더). **`my-app/my-app/`** 은 본 앱이 아닌 예전 템플릿 조각이 남아 있을 수 있으니 **수정 대상이 아닙니다.**
5. **`npm run dev`** → 로컬에서 화면 확인.
6. **포트폴리오 데이터**: 브라우저마다 `localStorage` 에 저장됩니다. 새 PC·새 브라우저에서는 비어 있음이 정상입니다. 예전에 쓰던 **동기화 키**가 있으면 앱의 **서버 동기화(Pull)** 로 같은 데이터를 불러오거나, 예전 PC에서 키를 확인해 입력하세요.
7. 최신 코드는 **`git pull origin main`** 으로 맞춥니다.

**코드 최신본**은 GitHub `main` 기준이며, 배포는 보통 `my-app`에서 `npm run deploy`(빌드·푸시) 또는 Vercel Git 연동으로 반영됩니다.

### 1. 필수 도구

- **Node.js** 20 이상 (LTS 권장)
- **Git**
- (배포 시) **Vercel** 계정 및 이 저장소 연결, 또는 **GitHub** 푸시 권한

### 2. 저장소 받기

```bash
git clone https://github.com/dkfalfxn-netizen/Portfolio.git
cd Portfolio
```

### 3. 의존성 설치

저장소 루트에서:

```bash
npm install --prefix my-app
```

또는 `my-app` 폴더로 들어가 `npm install`.

### 4. 환경 변수 (필수)

1. `my-app/.env.example` 을 복사해 **`my-app/.env.local`** 로 저장합니다.

   **PowerShell (Windows)**

   ```powershell
   Copy-Item my-app\.env.example my-app\.env.local
   ```

   **macOS / Linux**

   ```bash
   cp my-app/.env.example my-app/.env.local
   ```

2. `.env.local` 을 열어 값을 채웁니다.

   | 변수 | 용도 |
   |------|------|
   | `NEXT_PUBLIC_SUPABASE_URL` | Supabase 프로젝트 URL (`https://xxx.supabase.co`) |
   | `SUPABASE_SERVICE_ROLE_KEY` | 서버 전용. `/api/sync` 등 관리자 API용 (Git에 넣지 말 것) |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 브라우저 Supabase 클라이언트 사용 시 (선택) |

3. **이전 PC에만 있는 값**은 다음 중 하나로 가져옵니다.

   - 예전 PC의 `my-app/.env.local` 파일을 복사 (USB·클라우드 등)
   - **Vercel** → 프로젝트 → **Settings → Environment Variables** 에서 동일 이름 확인 후 로컬에 붙여넣기

4. **선택 변수** (기능 켤 때만 — **프로덕션(Vercel)에도 동일 이름으로 등록**)

   | 변수 | 용도 |
   |------|------|
   | `RESEND_API_KEY` | 이메일 알림 (Resend) — 비중 이탈 알림 |
   | `RESEND_FROM` | (선택) 발신자 표시명 |
   | `TELEGRAM_BOT_TOKEN` | 텔레그램 일일 시세 알림 (`/api/alert/kakao-price-move`) |
   | `TELEGRAM_CHAT_ID` | 수신 채팅 ID |
   | `TELEGRAM_ALERT_SYNC_KEY` | (권장) 본인 **동기화 키**와 동일하게 설정 시, 크론이 **그 키의 보유·관심종목만** 텔레그램 발송 |
   | `CRON_SECRET` | Vercel Cron GET 호출 시 `Authorization: Bearer …` 검증. **프로덕션에서는 설정 권장** |
   | `OPENAI_API_KEY` | AI 데일리 마켓 인사이트 (`/api/cron/analyze-market`) |
   | `DATABASE_URL` | Prisma CLI (`prisma migrate` 등) 사용 시에만 |

### 5. 로컬 실행

저장소 루트:

```bash
npm run dev
```

또는 `cd my-app` 후 `npm run dev` → 브라우저에서 [http://localhost:3000](http://localhost:3000)

### 6. 빌드 확인

```bash
npm run build
```

(루트 스크립트는 `my-app` 에서 빌드합니다.)

### 7. 배포 (Vercel + Git)

이 저장소는 **`my-app` 에서 `npm run deploy`** 하면:

1. `my-app` 빌드
2. 변경 사항이 있으면 `git commit -m "chore: deploy"`
3. `git push` → **Vercel이 Git 연동으로 자동 배포**

**Vercel 쪽 설정 참고**

- 프로젝트 **Root Directory** 가 `my-app` 이면 `my-app/vercel.json` 의 Cron·빌드 설정이 적용됩니다.
- 프로덕션에도 **환경 변수**를 Vercel에 등록해야 동기화·알림이 동작합니다 (로컬 `.env.local` 은 Git에 없음).

### 8. Vercel Cron (스케줄 요약)

`my-app/vercel.json` 기준 (UTC → 한국은 **KST = UTC+9**):

| 경로 | UTC | 대략 KST | 역할 |
|------|-----|----------|------|
| `/api/alert/check` | `0 7 * * *` | 매일 **16:00** | 일별 스냅샷 저장(`saveAllSnapshots`), 이메일 알림 처리 |
| `/api/cron/liquidity-briefing` | `0 0 * * *` | 매일 **09:00** | 순유동성·DXY·미10년·신용스프레드·VIX·BTC·금 텔레그램 브리핑 |
| `/api/alert/kakao-price-move` | `0 7 * * *` | 매일 **16:00** | 텔레그램 보유 브리핑 + 관심종목 시그널 (`TELEGRAM_ALERT_SYNC_KEY` 필요) |
| `/api/cron/analyze-market` | `0 21 * * *` | 매일 **06:00** | AI 마켓 인사이트 |
| `/api/cron/kcif-pdf-summary` | `1 9 * * *` | 매일 **18:01** | KCIF 보고서 PDF 본문 추출 후 AI 요약 텔레그램 발송 |

**일별 자산 스냅샷**은 한국 장 마감(15:30) 직후에 가깝게 맞추기 위해 **오후 4시 KST**에 기록합니다. 앱에서 서버로 보내는 클라이언트 스냅샷도 같은 날 **KST 16시 이후**에만 전송되도록 되어 있습니다.

### 9. Supabase 테이블 (신규 프로젝트·빈 DB)

Supabase SQL 편집기에서 **아래 순서**로 실행합니다 (파일은 `my-app/supabase/*.sql`).

1. `portfolio_snapshots.sql` — 동기화 본문(종목·현금)
2. `portfolio_snapshots_holdings_sort.sql` — 정렬 컬럼 추가(기존 DB 업그레이드용)
3. `portfolio_daily_snapshots.sql` — 일별 자산 (1번의 `sync_key` 참조)
4. `alert_configs.sql` — 이메일 알림 규칙
5. `price_move_alert_logs.sql` — 텔레그램 중복 발송 방지 로그
6. `watchlist_column.sql` — 관심종목 JSON 컬럼 (`portfolio_snapshots.watchlist`)
7. `market_reports.sql` — (해당 기능 사용 시)
8. `liquidity_briefings.sql` — 오전 9시 유동성 지표 시계열/AI 요약 저장

### 10. 브라우저 localStorage 키 (디버깅·이전 시 참고)

| 키 | 의미 |
|----|------|
| `portfolio_sync_key_v1` | 동기화 키 |
| `portfolio_last_sync_ts_v1` | 마지막으로 맞춘 서버 `updated_at` |
| `portfolio_has_local_changes_v1` | `"1"` 이면 로컬 수정 후 서버 미반영 |
| `portfolio_daily_snapshots_v1` | 일별 스냅샷 JSON (달력·추이) |
| `portfolio_snapshot_pushed_date_v1` / `portfolio_snapshot_pushed_total_v1` | 당일 서버 스냅샷 push 여부·총액 |

### 11. 자주 쓰는 명령 (루트 기준)

| 명령 | 설명 |
|------|------|
| `npm run dev` | 개발 서버 |
| `npm run build` | 프로덕션 빌드 |
| `npm run lint` | ESLint |
| `npm run deploy` | 빌드 후 커밋·푸시 ( `my-app` 에서 실행하는 것과 동일 스크립트 ) |

---

## 디렉터리 요약

| 경로 | 내용 |
|------|------|
| `my-app/` | Next.js 앱 (`app/`, `lib/`, `vercel.json` 등) |
| `my-app/supabase/*.sql` | Supabase 테이블 생성·마이그레이션 (신규 프로젝트 시 순서대로 실행) |
| `my-app/.env.example` | 환경 변수 템플릿 (커밋됨) |
| `scripts/deploy.cjs` | 배포용: 빌드 → 커밋(변경 시) → 푸시 |

비밀 값은 **절대 Git에 커밋하지 말고**, 새 환경에서는 `.env.local` 복사 또는 Vercel에서 다시 입력하세요.

---

## 포트폴리오 데이터가 새 PC에서 비어 있을 때

- **코드는 Git에 있지만**, 종목·현금·정렬·동기화 키 등은 **브라우저 로컬 저장소**와 (설정한 경우) **Supabase 동기화 서버**에 있습니다.
- 새 PC에서는 **`.env.local`** 과 **동기화 키(또는 서버 Pull)** 만 맞으면, 이전과 같은 서버 데이터를 이어서 쓸 수 있습니다.
- 동기화를 쓰지 않았다면 예전 PC에서 데이터를 내보내는 전용 메뉴는 없으므로, **동기화 키를 미리 적어두거나** 한번 서버에 올린 뒤 새 PC에서 Pull 하는 방식을 권장합니다.

**동기화(클라이언트)**: 브라우저마다 `localStorage`에 **마지막으로 맞춘 서버 시각**(`portfolio_last_sync_ts_v1`)과 **로컬 수정 여부**(`portfolio_has_local_changes_v1`)가 저장됩니다. 새 브라우저에서는 비어 있으므로, 같은 동기화 키로 **서버에서 불러오기**를 한 번 하면 서버 기준으로 맞춰집니다. **동시에 두 기기에서 편집**하면 마지막 저장이 덮어쓸 수 있으니, 한쪽에서 저장이 끝난 뒤 다른 쪽을 여는 것이 안전합니다.

**충돌 시 동작**: 서버가 더 최신이어도 **로컬에 미반영 변경**(`portfolio_has_local_changes_v1 === "1"`)이 있으면 서버 데이터로 덮어쓰지 않고 **먼저 로컬을 서버에 올립니다.** (입력 직후 현금·종목이 사라지는 문제 방지)

---

## UI·로직 참고 (최근 기능)

- **총 평가 옆 달러**: 해당 구간 **총 평가 원화 ÷ USD/KRW** (시세 API 환율, 없으면 기본값).
- **종목별 평가금액**: USD·EUR 종목은 원화 아래에 **수량×현재가** 기준 달러/유로 표시.
- **서버 동기화**: 위 충돌 규칙 + 자동 저장은 로컬 수정이 있을 때만 서버로 전송.
- **일별 자산 스냅샷**: Vercel Cron **오후 4시 KST** + 앱은 **같은 날 KST 16시 이후**에만 서버로 일별 스냅샷 전송(장 마감 후 종가에 가깝게 비교).
- **텔레그램**: `/api/alert/kakao-price-move` — 보유 전 종목, 종목명 표시, 매일 16:00 KST(크론). 앱에서 **진단(전송 없음)** 버튼으로 환경변수·시세 점검 가능.
- **배포**: `my-app` 에서 `npm run deploy` → 빌드 후 변경 시 커밋·`git push` → Vercel 자동 배포.
