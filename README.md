# Portfolio

주식 포트폴리오·동기화·알림이 포함된 Next.js 앱입니다. **앱 소스는 `my-app/`** 에 있습니다.

## 다른 PC·새 환경에서 이어하기

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
