#!/usr/bin/env bash
# Claude Code 세션 시작 시 의존성을 자동으로 맞춘다(멱등). 실패해도 세션은 막지 않는다.
set -u
ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
APP="$ROOT/my-app"
[ -d "$APP" ] || exit 0
cd "$APP" || exit 0

need_install=0
[ -d node_modules ] || need_install=1
[ -f node_modules/.package-lock.json ] && [ package-lock.json -nt node_modules/.package-lock.json ] && need_install=1

if [ "$need_install" = 1 ]; then
  echo "[session-start] my-app 의존성 설치 (npm ci)…" >&2
  npm ci --no-audit --no-fund >&2 || npm install --no-audit --no-fund >&2 || echo "[session-start] 설치 실패 — 수동으로 npm install 필요" >&2
fi

[ -f .env.local ] || echo "[session-start] my-app/.env.local 없음 — .env.example 복사 후 채우세요(비밀값은 Git에 없음)." >&2
exit 0
