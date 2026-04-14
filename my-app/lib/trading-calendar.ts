/**
 * 미국(NYSE·NASDAQ 정규장) / 한국(KRX) 현물의 "오늘이 거래일인지" 근사 판별.
 * 공휴일·대체휴일은 연도별로 수동 보강합니다. 설·추석 등은 매년 KRX 공시와 맞춰 갱신하는 것을 권장합니다.
 */

function ymdInTimeZone(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function weekdayInTimeZone(d: Date, timeZone: string): number {
  const w = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(d);
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[w] ?? 0;
}

/** NYSE 정규장 휴장일 (America/New_York 달력 기준 YYYY-MM-DD) */
const NYSE_CLOSED = new Set<string>([
  // 2024
  "2024-01-01",
  "2024-01-15",
  "2024-02-19",
  "2024-03-29",
  "2024-05-27",
  "2024-06-19",
  "2024-07-04",
  "2024-09-02",
  "2024-11-28",
  "2024-12-25",
  // 2025
  "2025-01-01",
  "2025-01-20",
  "2025-02-17",
  "2025-04-18",
  "2025-05-26",
  "2025-06-19",
  "2025-07-04",
  "2025-09-01",
  "2025-11-27",
  "2025-12-25",
  // 2026
  "2026-01-01",
  "2026-01-19",
  "2026-02-16",
  "2026-04-03",
  "2026-05-25",
  "2026-06-19",
  "2026-07-03",
  "2026-09-07",
  "2026-11-26",
  "2026-12-25",
  // 2027
  "2027-01-01",
  "2027-01-18",
  "2027-02-15",
  "2027-03-26",
  "2027-05-31",
  "2027-06-18",
  "2027-07-05",
  "2027-09-06",
  "2027-11-25",
  "2027-12-24",
  // 2028
  "2028-01-17",
  "2028-02-21",
  "2028-04-14",
  "2028-05-29",
  "2028-06-19",
  "2028-07-04",
  "2028-09-04",
  "2028-11-23",
  "2028-12-25",
]);

/** KRX 현물 휴장일 (Asia/Seoul 달력 기준 YYYY-MM-DD) — 법정·대체휴일·연말 휴장 등 */
const KRX_CLOSED = new Set<string>([
  // 2024
  "2024-01-01",
  "2024-02-09",
  "2024-02-12",
  "2024-03-01",
  "2024-04-10",
  "2024-05-01",
  "2024-05-05",
  "2024-05-15",
  "2024-06-06",
  "2024-08-15",
  "2024-09-16",
  "2024-09-17",
  "2024-09-18",
  "2024-10-03",
  "2024-10-09",
  "2024-12-25",
  "2024-12-31",
  // 2025
  "2025-01-01",
  "2025-01-27",
  "2025-01-28",
  "2025-01-29",
  "2025-03-03",
  "2025-05-01",
  "2025-05-05",
  "2025-05-06",
  "2025-06-06",
  "2025-08-15",
  "2025-10-03",
  "2025-10-05",
  "2025-10-06",
  "2025-10-07",
  "2025-10-08",
  "2025-10-09",
  "2025-12-25",
  "2025-12-31",
  // 2026 (KRX 공시·관행에 맞춰 보강; 매년 확인 권장)
  "2026-01-01",
  "2026-02-16",
  "2026-02-17",
  "2026-02-18",
  "2026-03-02",
  "2026-05-01",
  "2026-05-05",
  "2026-05-25",
  "2026-06-08",
  "2026-08-17",
  "2026-09-24",
  "2026-09-25",
  "2026-10-05",
  "2026-10-09",
  "2026-12-25",
  "2026-12-31",
  // 2027
  "2027-01-01",
  "2027-02-07",
  "2027-02-08",
  "2027-02-09",
  "2027-03-02",
  "2027-05-05",
  "2027-05-13",
  "2027-06-07",
  "2027-08-16",
  "2027-10-04",
  "2027-10-11",
  "2027-12-31",
  // 2028
  "2028-01-01",
  "2028-01-27",
  "2028-01-28",
  "2028-01-31",
  "2028-03-01",
  "2028-05-05",
  "2028-06-06",
  "2028-08-15",
  "2028-10-03",
  "2028-10-05",
  "2028-10-06",
  "2028-10-09",
  "2028-12-25",
  "2028-12-29",
]);

/**
 * 미국 현금 주식 정규장 기준: 뉴욕 달력이 평일이고 NYSE 휴장일이 아닐 때.
 */
export function isUsEquityTradingSessionDay(at: Date = new Date()): boolean {
  const ymd = ymdInTimeZone(at, "America/New_York");
  const wd = weekdayInTimeZone(at, "America/New_York");
  if (wd === 0 || wd === 6) return false;
  if (NYSE_CLOSED.has(ymd)) return false;
  return true;
}

/**
 * KRX 현물 기준: 서울 달력이 평일이고 KRX 휴장일이 아닐 때.
 */
export function isKrEquityTradingSessionDay(at: Date = new Date()): boolean {
  const ymd = ymdInTimeZone(at, "Asia/Seoul");
  const wd = weekdayInTimeZone(at, "Asia/Seoul");
  if (wd === 0 || wd === 6) return false;
  if (KRX_CLOSED.has(ymd)) return false;
  return true;
}

/** 김승주: 미국장 영업일 / 그 외: 한국장 영업일 — 전일 대비 등락 표시 여부 */
export function shouldShowDailyChangeVsPreviousClose(
  ownerName: string,
  at: Date = new Date(),
): boolean {
  if (ownerName === "김승주") return isUsEquityTradingSessionDay(at);
  return isKrEquityTradingSessionDay(at);
}
