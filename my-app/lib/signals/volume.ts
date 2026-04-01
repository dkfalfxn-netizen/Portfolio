import type { DailyPrice, TradeSignal } from "./types";

/**
 * 거래량 시그널 (20일 평균 거래량 대비 급증 여부 + 당일 방향)
 *
 * 규칙:
 * - 최근 거래량 >= (20일 평균 거래량 * 1.5) 이고, 당일 종가 > 전일 종가  => BUY
 * - 최근 거래량 >= (20일 평균 거래량 * 1.5) 이고, 당일 종가 < 전일 종가  => SELL
 * - 그 외 => HOLD
 *
 * 의도:
 * - 거래량이 터진 날의 방향성을 시그널로 보강
 * - 거래량이 평소 수준이면 과도한 신호를 내지 않도록 HOLD
 */
export function calculateVolumeSignal(
  prices: DailyPrice[],
  volumePeriod = 20,
  spikeMultiple = 1.5,
): TradeSignal {
  if (!Array.isArray(prices) || prices.length < volumePeriod + 1) return "HOLD";
  if (!Number.isFinite(spikeMultiple) || spikeMultiple <= 0) return "HOLD";

  const n = prices.length;
  const last = prices[n - 1];
  const prev = prices[n - 2];

  if (
    !Number.isFinite(last.close) ||
    !Number.isFinite(prev.close) ||
    !Number.isFinite(last.volume) ||
    last.close <= 0 ||
    prev.close <= 0 ||
    last.volume < 0
  ) {
    return "HOLD";
  }

  let sumVol = 0;
  // 전일까지 volumePeriod일 평균 (당일 거래량과 비교)
  for (let i = n - 1 - volumePeriod; i <= n - 2; i++) {
    const v = prices[i]?.volume;
    if (!Number.isFinite(v) || v < 0) return "HOLD";
    sumVol += v;
  }
  const avgVol = sumVol / volumePeriod;
  if (!Number.isFinite(avgVol) || avgVol <= 0) return "HOLD";

  const isSpike = last.volume >= avgVol * spikeMultiple;
  if (!isSpike) return "HOLD";

  if (last.close > prev.close) return "BUY";
  if (last.close < prev.close) return "SELL";
  return "HOLD";
}

