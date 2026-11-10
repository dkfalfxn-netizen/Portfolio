# 기출 오답노트

학생별 시험 오답 기록 · 배점 자동 채점 · 문항별 오답 통계 · **오답만 추출(Claude 분석/유사문제용)**.
Portfolio 앱(`my-app/`)과 무관한 독립 앱이다.

## 실행 (로컬 모드 — 설치만 하면 바로 사용)

```bash
npm install
npm run dev
```

- http://localhost:3000 → **선생님** 탭, 비밀번호 `teacher` (로컬 기본값)
- `학생 관리`에서 학생을 추가하면 PIN이 나온다 → 학생은 이름 + PIN으로 로그인
- 데이터는 `data/db.json` 에 저장된다 (Git에 올라가지 않음. 백업하려면 이 파일을 복사)

## 역할과 권한

| | 선생님 | 학생 |
|---|---|---|
| 시험지(배점·단원·자료 링크) 관리 | O | 보기만 |
| 학생 추가 · PIN 재설정 · 삭제 | O | X |
| 오답 기록 | 모든 학생 | 본인만 |
| 기록 보기 · 통계 · 오답 추출 | 전체 | **본인 것만** |

학생 차단은 서버 API에서 한다: 학생 로그인 쿠키(서명됨)에 든 학생 id로 모든 조회·수정·추출을 강제하므로
URL이나 요청을 조작해도 다른 학생 기록은 볼 수 없다.

## 오답 추출 → Claude

`오답 추출` 에서 학생·시험지·기간을 고르고 **오답 추출** → 복사(또는 .md/.csv 저장).
결과에는 문항별 배점·받은 점수·단원·오답 원인·메모와 Claude 요청문(오답 분석 + 문항당 유사 문제 2개)이 들어간다.
Claude에 붙여넣을 때 **시험지·정답 PDF를 같이 첨부**해야 실제 문제 내용을 보고 유사 문제를 만든다.

## 배포 (여러 기기·학생이 쓰려면)

로컬 모드는 내 PC에서만 열린다. 학생들이 각자 폰으로 쓰려면 Vercel + Supabase:

1. Supabase 새 프로젝트 → SQL Editor에서 `supabase/schema.sql` 실행
2. Vercel에 이 폴더를 프로젝트로 연결하고 환경변수 설정 (`.env.example` 참고)
   - `TEACHER_PASSWORD`, `SESSION_SECRET`(긴 임의 문자열), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
3. 배포 환경에서는 위 값이 없으면 동작하지 않는다(안전장치).

## 구조

- `app/page.tsx` 로그인 · `app/teacher` 선생님 · `app/student` 학생
- `app/api/*` 인증·시험지·학생·기록·추출 API
- `lib/store.ts` 저장소 (Supabase 환경변수가 있으면 Supabase, 없으면 `data/db.json`)
- `lib/auth.ts` 쿠키 서명·PIN 해시(scrypt)·로그인 시도 제한
- `lib/scoring.ts` 채점 · `lib/export.ts` 오답 추출 마크다운
