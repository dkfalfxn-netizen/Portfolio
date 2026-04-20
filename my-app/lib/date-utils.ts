/**
 * KST(Asia/Seoul) 날짜 유틸리티 — 공유 모듈
 *
 * Date.now() + 9h 오프셋 방식은 한국(UTC+9 고정)에서 통상적으로 맞지만,
 * Intl API를 사용하는 것이 표준적이고 런타임 환경 변화에 안전합니다.
 */

const TZ = "Asia/Seoul";

/** 오늘 KST 날짜 (YYYY-MM-DD) */
export function todayKST(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** 어제 KST 날짜 (YYYY-MM-DD) */
export function yesterdayKST(at: Date = new Date()): string {
  const d = new Date(at);
  d.setDate(d.getDate() - 1);
  return todayKST(d);
}

/** KST 기준 MM/DD 문자열 (예: "04/21") */
export function mmddKST(at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const m = parts.find((p) => p.type === "month")?.value ?? "??";
  const day = parts.find((p) => p.type === "day")?.value ?? "??";
  return `${m}/${day}`;
}

/** KST 기준 YYYY-MM-DD HH:MM 문자열 */
export function nowLabelKST(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
    .format(at)
    .replace("T", " ");
}
