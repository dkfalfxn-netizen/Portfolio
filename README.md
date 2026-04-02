# Portfolio

주식 포트폴리오·동기화·알림이 포함된 Next.js 앱입니다. **앱 소스는 `my-app/`** 에 있습니다.

## 다른 PC·새 환경에서 이어하기

### 0. 한눈에 체크리스트

1. **Git** 으로 이 저장소를 받고 (`git clone` … `cd Portfolio`) **의존성 설치** (`npm install --prefix my-app`).
2. **`my-app/.env.local`** 생성 — 아래 [환경 변수](#4-환경-변수-필수) 참고. 예전 PC의 `.env.local` 복사 또는 Vercel 환경 변수 복사.
3. **에디터**에서 워크스페이스 루트는 **`Portfolio`** (클론한 폴더). **`my-app/my-app/`** 은 본 앱이 아닌 예전 템플릿 조각이 남아 있을 수 있으니 **수정 대상이 아닙니다.**
4. **`npm run dev`** → 로컬에서 화면 확인.
5. **포트폴리오 데이터**: 브라우저마다 `localStorage` 에 저장됩니다. 새 PC·새 브라우저에서는 비어 있음이 정상입니다. 예전에 쓰던 **동기화 키**가 있으면 앱의 **서버 동기화(Pull)** 로 같은 데이터를 불러오거나, 예전 PC에서 키를 확인해 입력하세요.
6. 최신 코드는 **`git pull origin main`** 으로 맞춥니다.

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

4. **선택 변수** (기능 켤 때만)

   | 변수 | 용도 |
   |------|------|
   | `RESEND_API_KEY` | 이메일 알림 (Resend) |
   | `CRON_SECRET` | Vercel Cron이 `/api/alert/check` 호출 시 `Authorization: Bearer …` 검증용. 비우면 GET 검증 생략(개발 편의) |
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

### 8. 자주 쓰는 명령 (루트 기준)

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
| `my-app/.env.example` | 환경 변수 템플릿 (커밋됨) |
| `scripts/deploy.cjs` | 배포용: 빌드 → 커밋(변경 시) → 푸시 |

비밀 값은 **절대 Git에 커밋하지 말고**, 새 환경에서는 `.env.local` 복사 또는 Vercel에서 다시 입력하세요.

---

## 포트폴리오 데이터가 새 PC에서 비어 있을 때

- **코드는 Git에 있지만**, 종목·현금·정렬·동기화 키 등은 **브라우저 로컬 저장소**와 (설정한 경우) **Supabase 동기화 서버**에 있습니다.
- 새 PC에서는 **`.env.local`** 과 **동기화 키(또는 서버 Pull)** 만 맞으면, 이전과 같은 서버 데이터를 이어서 쓸 수 있습니다.
- 동기화를 쓰지 않았다면 예전 PC에서 데이터를 내보내는 전용 메뉴는 없으므로, **동기화 키를 미리 적어두거나** 한번 서버에 올린 뒤 새 PC에서 Pull 하는 방식을 권장합니다.

**동기화(클라이언트)**: 브라우저마다 `localStorage`에 **마지막으로 맞춘 서버 시각**(`portfolio_last_sync_ts_v1`)과 **로컬 수정 여부**(`portfolio_has_local_changes_v1`)가 저장됩니다. 새 브라우저에서는 비어 있으므로, 같은 동기화 키로 **서버에서 불러오기**를 한 번 하면 서버 기준으로 맞춰집니다. **동시에 두 기기에서 편집**하면 마지막 저장이 덮어쓸 수 있으니, 한쪽에서 저장이 끝난 뒤 다른 쪽을 여는 것이 안전합니다.

---

## UI·로직 참고 (최근 기능)

- **총 평가 옆 달러**: 해당 구간 **총 평가 원화 ÷ USD/KRW** (시세 API 환율, 없으면 기본값).
- **종목별 평가금액**: USD·EUR 종목은 원화 아래에 **수량×현재가** 기준 달러/유로 표시.
- **서버 동기화**: Pull 시 서버 `updated_at`과 로컬에 저장한 마지막 동기 시각을 비교하고, 실제 사용자 수정이 있을 때만 Push·자동저장이 서버로 올라가도록 동작합니다.
- **배포**: `my-app` 에서 `npm run deploy` → 빌드 후 변경 시 커밋·`git push` → Vercel 자동 배포.
