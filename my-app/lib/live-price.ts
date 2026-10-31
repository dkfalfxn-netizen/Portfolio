/**
 * 미국 종목 현재가 소스 선택.
 *
 * KIS 현재체결가 API 는 두 가지 한계가 있다.
 *  1) 프리·애프터(04:00~09:30 / 16:00~20:00 ET)에도 정규장 종가(last)를 돌려주는 것으로 보인다.
 *  2) 미국 야간(BlueOcean 주간거래)은 일~목요일 밤(20:00~다음날 04:00 ET)에만 열린다.
 *     금요일 20:00 ET ~ 일요일 20:00 ET 에는 닫혀 있는데도 직전 세션의 마지막 가격이 그대로 내려와,
 *     실제 시간외 가격과 다른 "오래된 가격"이 표시된다.
 * 야후 1분봉(프리/애프터 포함)은 정규장 + 시간외 마지막 체결가를 주므로, KIS 는 아래 경우에만 쓴다.
 *   - 정규장(REGULAR)
 *   - BlueOcean 야간거래가 실제로 열려 있는 시간
 *   - 야후 가격이 없을 때(최후 수단)
 */
export type YahooMarketState = "REGULAR" | "PRE" | "POST" | "POSTPOST" | "PREPRE" | "CLOSED" | null;
export type LivePriceSource = "kis" | "yahoo" | "none";

const valid = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/** BlueOcean(KIS 주간거래) 야간 세션이 열려 있는가 — 일~목 20:00 ET ~ 다음날 04:00 ET (미국 동부시간 기준, 서머타임 자동 반영) */
export function isBlueOceanOvernightOpen(now: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  // 저녁 세션: 일~목 20:00 이후
  if (hour >= 20) return wd === "Sun" || wd === "Mon" || wd === "Tue" || wd === "Wed" || wd === "Thu";
  // 새벽 세션: 월~금 04:00 이전(= 전날 밤 세션의 연장)
  if (hour < 4) return wd === "Mon" || wd === "Tue" || wd === "Wed" || wd === "Thu" || wd === "Fri";
  return false;
}

export function chooseUsLiveSource(args: {
  yahooPrice: number | null | undefined;
  yahooState: YahooMarketState | undefined;
  kisPrice: number | null | undefined;
  now?: Date;
}): LivePriceSource {
  const { yahooPrice, yahooState, kisPrice, now } = args;
  // 정규장: 기존대로 KIS 우선
  if (yahooState === "REGULAR" && valid(kisPrice)) return "kis";
  // 프리/애프터: 야후(시간외 체결가) 우선
  if ((yahooState === "PRE" || yahooState === "POST") && valid(yahooPrice)) return "yahoo";
  // 그 외(야간·새벽·주말·휴장·상태 불명): BlueOcean 이 열려 있을 때만 KIS, 닫혀 있으면 야후의 마지막 체결가
  if (isBlueOceanOvernightOpen(now) && valid(kisPrice)) return "kis";
  if (valid(yahooPrice)) return "yahoo";
  if (valid(kisPrice)) return "kis";
  return "none";
}
