/**
 * KST(Asia/Seoul) 날짜 유틸리티 — 공유 모듈
 *
 * Date.now() + 9h 오프셋 방식은 한국(UTC+9 고정)에서 통상적으로 맞지만,
 * Intl API를 사용하는 것이 표준적이고 런타임 환경 변화에 안전합니다.
 */

const TZ = "Asia/Seoul";

/** 오늘 KST 날짜 (YYYY-MM-DD) */
export function todayKST(at: Date = new Date()): string {
  return ymdKST(at);
}

/** `Date` 시각이 가리키는 순간의 KST 달력 날짜 (YYYY-MM-DD). 스냅샷 키와 매칭할 때 사용 */
export function ymdKST(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** 어제 KST 날짜 (YYYY-MM-DD)
 *
 * setDate(getDate()-1)은 서버 로컬 TZ(UTC) 기준으로 하루를 빼므로
 * KST 자정 근처에서 날짜가 어긋날 수 있음.
 * 한국은 DST 없이 UTC+9 고정이므로 정확히 86400초를 빼는 방식이 안전합니다.
 */
export function yesterdayKST(at: Date = new Date()): string {
  return ymdKST(new Date(at.getTime() - 24 * 60 * 60 * 1000));
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

/** KST(Asia/Seoul) 기준 토요일·일요일이면 true (자동 크론 등에 사용) */
export function isKstWeekend(at: Date = new Date()): boolean {
  const wd = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "short",
  }).format(at);
  return wd === "Sat" || wd === "Sun";
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
