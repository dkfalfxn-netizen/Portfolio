/**
 * 금액 표시 통일 — 모든 화면에서 천 단위 콤마(숫자 그룹 구분).
 * 브라우저 기본 로케일에 의존하지 않도록 ko-KR / en-US 를 명시합니다.
 */

export const MONEY_INT_LOCALE = "ko-KR" as const;

/** 수익 + 빨강, 손실 - 파랑 (달러·원화·%·금액 각각 적용) */
export function signedPnlTextClass(value: number): string {
  if (value > 0) return "text-red-500";
  if (value < 0) return "text-blue-500";
  return "text-muted-foreground";
}

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

/** 콤마·기타 제거 후 소수 파싱 (USD 현금 입력 필드 onChange용, 소수점은 1개까지만 허용) */
export function parseUsdCashDigits(raw: string): number {
  const cleaned = raw.replace(/[^0-9.]/g, "");
  const firstDot = cleaned.indexOf(".");
  const normalized =
    firstDot === -1 ? cleaned : cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, "");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
}

/** USD 현금 입력 필드 표시용 (콤마, 불필요한 소수 0은 생략) */
export function fmtUsdCashDisplay(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "";
  return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
