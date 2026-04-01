import type { DailyPrice, TradeSignal } from "./types";
import { isInvalidNumber, smaAt } from "./math";

const SHORT = 20;
const LONG = 60;

/**
 * 20일 SMA와 60일 SMA의 교차(골든/데드)를 **마지막 거래일 기준**으로 판단합니다.
 *
 * - 골든크로스(BUY): 전일까지는 20일선이 60일선 이하(이하 또는 같음)였는데,
 *   당일(배열의 마지막 봉)에는 20일선이 60일선을 위로 돌파한 경우.
 * - 데드크로스(SELL): 전일까지는 20일선이 60일선 이상이었는데,
 *   당일에는 20일선이 60일선 아래로 이탈한 경우.
 * - 그 외: HOLD
 *
 * 데이터: 최소 61개 일봉이 필요합니다 (전일·당일 각각에서 60일 SMA 계산 가능하려면
 * 전일 인덱스가 최소 59여야 하므로, 마지막 인덱스 n-1 >= 60 → n >= 61).
 */
export function calculateMACrossoverSignal(prices: DailyPrice[]): TradeSignal {
  if (!Array.isArray(prices) || prices.length === 0) return "HOLD";

  const closes = prices.map((p) => p.close);
  for (const c of closes) {
    if (isInvalidNumber(c) || c <= 0) return "HOLD";
  }

  const n = closes.length;
  /** 전일·당일 모두 60일 SMA를 계산하려면 마지막에서 두 번째 인덱스가 최소 59 */
  if (n < LONG + 2) return "HOLD";

  const prev = n - 2;
  const last = n - 1;

  const s20p = smaAt(closes, SHORT, prev);
  const s60p = smaAt(closes, LONG, prev);
  const s20c = smaAt(closes, SHORT, last);
  const s60c = smaAt(closes, LONG, last);

  if (s20p === null || s60p === null || s20c === null || s60c === null) return "HOLD";

  const wasBelowOrEqual = s20p <= s60p;
  const isAbove = s20c > s60c;
  const wasAboveOrEqual = s20p >= s60p;
  const isBelow = s20c < s60c;

  if (wasBelowOrEqual && isAbove) return "BUY";
  if (wasAboveOrEqual && isBelow) return "SELL";
  return "HOLD";
}
