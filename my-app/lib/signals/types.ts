/**
 * 일봉 OHLCV — 과거(오래된 날) → 최신 순으로 정렬되어 있다고 가정합니다.
 */
export type DailyPrice = {
  date: string;
  close: number;
  high: number;
  low: number;
  volume: number;
};

/** 매수 / 매도 / 관망 */
export type TradeSignal = "BUY" | "SELL" | "HOLD";
