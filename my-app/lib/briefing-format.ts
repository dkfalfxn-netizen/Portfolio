const MIN_CLAUSE = 8;

function isStrictSequentialList(t: string, maxCheck = 6): boolean {
  const lines = t
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (lines.length < 2) return false;
  const n = Math.min(lines.length, maxCheck);
  for (let i = 0; i < n; i++) {
    if (!new RegExp(`^${i + 1}\\.\\s`).test(lines[i])) return false;
  }
  return true;
}

/**
 * 모델이 한 문단만 반환해도 UI에서 번호·줄바꿈이 보이도록 나눈다.
 * `1. ` … `2. ` … 순서로 이미 쓰인 경우만 그대로 둔다(‘2024. 04’ 같은 연도 줄로 오인하지 않음).
 */
export function coerceNumberedSummaryLines(body: string, maxLines = 6): string {
  const t = body.trim().replace(/\r\n/g, "\n");
  if (!t) return t;
  if (isStrictSequentialList(t, maxLines)) return t;

  const byNewline = t
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (byNewline.length >= 2) {
    return byNewline
      .map((c) => c.replace(/^\d{1,2}\.\s+/, ""))
      .slice(0, maxLines)
      .map((c, i) => `${i + 1}. ${c}`)
      .join("\n");
  }

  const bySentence = t
    .split(/(?<=[.!?。…])\s+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > MIN_CLAUSE);
  if (bySentence.length >= 2) {
    return bySentence
      .slice(0, maxLines)
      .map((s, i) => `${i + 1}. ${s}`)
      .join("\n");
  }

  const byComma = t
    .split(/(?<=[,，、])\s*/u)
    .map((s) => s.trim())
    .filter((s) => s.length > MIN_CLAUSE);
  if (byComma.length >= 2) {
    return byComma
      .slice(0, maxLines)
      .map((s, i) => `${i + 1}. ${s}`)
      .join("\n");
  }

  const shortChunks = t
    .split(/(?<=[.!?。…])\s+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (shortChunks.length >= 2) {
    return shortChunks
      .slice(0, maxLines)
      .map((s, i) => `${i + 1}. ${s}`)
      .join("\n");
  }

  if (t.length > 50) {
    return `1. ${t}`;
  }
  return t;
}

const BRIEF_LINK_BLOCK_SEP = "\n\n────────────────────────\n";

/**
 * `macro-*-briefing`이 저장한 문자열(본문 + 참고 링크 블록)에서 본문만 번호·줄나눔 보정.
 * 이전에 문단으로만 저장된 행도 대시보드에서 바로 정돈돼 보이게 한다.
 */
export function withCoercedBriefingBody(full: string, maxLines = 6): string {
  if (!full.includes("참고 링크 (위 요약")) {
    return coerceNumberedSummaryLines(full.trim(), maxLines);
  }
  const i = full.indexOf(BRIEF_LINK_BLOCK_SEP);
  if (i === -1) {
    return coerceNumberedSummaryLines(full.trim(), maxLines);
  }
  const head = full.slice(0, i).trim();
  const tail = full.slice(i);
  return `${coerceNumberedSummaryLines(head, maxLines)}${tail}`;
}
