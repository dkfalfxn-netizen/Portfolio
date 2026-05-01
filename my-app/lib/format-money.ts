/**
 * 금액 표시 통일 — 모든 화면에서 천 단위 콤마(숫자 그룹 구분).
 * 브라우저 기본 로케일에 의존하지 않도록 ko-KR / en-US 를 명시합니다.
 */

export const MONEY_INT_LOCALE = "ko-KR" as const;

/** 정수 원화·환율 등 (콤마) */
export function fmtInt(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString(MONEY_INT_LOCALE);
}

/** 콤마·기타 비숫자 제거 후 정수 (원화 입력 필드 onChange용) */
export function parseKoreanIntDigits(raw: string): number {
  const d = raw.replace(/[^\d]/g, "");
  if (d === "") return 0;
  const n = Number(d);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** ₩ + 정수 콤마 */
export function fmtKrwInt(n: number): string {
  return `₩${fmtInt(n)}`;
}

/**
 * USD 표시 금액 ($ + 천 단위 콤마, 소수 min~max자리)
 */
export function fmtUsdNumber(n: number, minFrac = 2, maxFrac = 4): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: minFrac,
    maximumFractionDigits: maxFrac,
  });
}

/** EUR 표시 (천 단위 콤마 — 점 소수점) */
export function fmtEurNumber(n: number, minFrac = 2, maxFrac = 4): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("de-DE", {
    minimumFractionDigits: minFrac,
    maximumFractionDigits: maxFrac,
  });
}
