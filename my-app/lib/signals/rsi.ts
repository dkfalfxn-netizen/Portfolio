import type { DailyPrice, TradeSignal } from "./types";
import { computeRSISeries, isInvalidNumber } from "./math";

const RSI_PERIOD = 14;
const OVERSOLD = 30;
const OVERBOUGHT = 70;

/**
 * 14일 RSI 기준:
 * - BUY: 전일 RSI <= 30 이고, 당일 RSI > 30 (30선 상향 돌파)
 * - SELL: 전일 RSI >= 70 이고, 당일 RSI < 70 (70선 하향 이탈)
 * - 그 외: HOLD
 *
 * Wilder RSI는 최소 (period + 1)개의 종가가 필요합니다 (첫 유효 RSI는 인덱스 period).
 * 전일·당일 RSI 비교를 하려면 마지막 인덱스 n-1에서 RSI가 존재해야 하므로
 * n-1 >= period → n >= 15.
 */
export function calculateRSISignal(prices: DailyPrice[]): TradeSignal {
  if (!Array.isArray(prices) || prices.length === 0) return "HOLD";

  const closes = prices.map((p) => p.close);
  for (const c of closes) {
    if (isInvalidNumber(c) || c <= 0) return "HOLD";
  }

  const n = closes.length;
  if (n < RSI_PERIOD + 1) return "HOLD";

  const rsiSeries = computeRSISeries(closes, RSI_PERIOD);
  const prevRsi = rsiSeries[n - 2];
  const lastRsi = rsiSeries[n - 1];

  if (prevRsi === null || lastRsi === null) return "HOLD";

  if (prevRsi <= OVERSOLD && lastRsi > OVERSOLD) return "BUY";
  if (prevRsi >= OVERBOUGHT && lastRsi < OVERBOUGHT) return "SELL";
  return "HOLD";
}
