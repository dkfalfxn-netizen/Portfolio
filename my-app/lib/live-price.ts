/**
 * 미국 종목 현재가 소스 선택.
 *
 * - KIS 현재체결가 API 는 프리·애프터 구간에도 정규장 종가(last)를 돌려주는 것으로 보여,
 *   야후가 프리/애프터(PRE/POST) 가격을 주는 구간에서는 야후를 우선한다.
 * - 정규장·미국 야간(20:00~04:00 ET, KIS 주간거래/BlueOcean)·야후 실패 시에는 기존대로 KIS 우선.
 */
export type YahooMarketState = "REGULAR" | "PRE" | "POST" | "POSTPOST" | "PREPRE" | "CLOSED" | null;
export type LivePriceSource = "kis" | "yahoo" | "none";

const valid = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

export function chooseUsLiveSource(args: {
  yahooPrice: number | null | undefined;
  yahooState: YahooMarketState | undefined;
  kisPrice: number | null | undefined;
}): LivePriceSource {
  const { yahooPrice, yahooState, kisPrice } = args;
  const extendedHours = yahooState === "PRE" || yahooState === "POST";
  if (extendedHours && valid(yahooPrice)) return "yahoo";
  if (valid(kisPrice)) return "kis";
  if (valid(yahooPrice)) return "yahoo";
  return "none";
}
