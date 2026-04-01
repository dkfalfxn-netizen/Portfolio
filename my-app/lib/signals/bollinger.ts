import type { DailyPrice, TradeSignal } from "./types";
import { isInvalidNumber, smaAt, stdevAt } from "./math";

const BB_PERIOD = 20;
const BB_MULT = 2;

function bollingerBandsAt(
  closes: number[],
  end: number,
  period: number,
  multiplier: number,
): { upper: number; lower: number } | null {
  const mid = smaAt(closes, period, end);
  const sd = stdevAt(closes, period, end);
  if (mid === null || sd === null) return null;
  return {
    upper: mid + multiplier * sd,
    lower: mid - multiplier * sd,
  };
}

/**
 * 볼린저 밴드(20일 SMA, 표준편차 2배):
 * - BUY: 전일 종가가 하단 밴드 **아래**였고, 당일 종가가 하단 밴드 **이상**으로 되돌아온 경우
 *   (하단 이탈 후 반등).
 * - SELL: 전일 종가가 상단 밴드 **위**였고, 당일 종가가 상단 밴드 **이하**로 내려온 경우
 *   (상단 돌파 후 되돌림).
 * - 둘 다 해당되면 희귀하지만, 우선 BUY를 먼저 판정합니다.
 *
 * 각 봉마다 밴드 계산에 20일치가 필요하므로, 전일 인덱스는 최소 19 → 전체 길이 n >= 21.
 */
export function calculateBollingerSignal(prices: DailyPrice[]): TradeSignal {
  if (!Array.isArray(prices) || prices.length === 0) return "HOLD";

  const closes = prices.map((p) => p.close);
  for (const c of closes) {
    if (isInvalidNumber(c) || c <= 0) return "HOLD";
  }

  const n = closes.length;
  if (n < BB_PERIOD + 1) return "HOLD";

  const prev = n - 2;
  const last = n - 1;

  const bandsPrev = bollingerBandsAt(closes, prev, BB_PERIOD, BB_MULT);
  const bandsLast = bollingerBandsAt(closes, last, BB_PERIOD, BB_MULT);
  if (!bandsPrev || !bandsLast) return "HOLD";

  const cPrev = closes[prev];
  const cLast = closes[last];

  const buyBounce = cPrev < bandsPrev.lower && cLast >= bandsLast.lower;
  const sellReject = cPrev > bandsPrev.upper && cLast <= bandsLast.upper;

  if (buyBounce) return "BUY";
  if (sellReject) return "SELL";
  return "HOLD";
}
