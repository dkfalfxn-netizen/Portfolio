/**
 * 차트 지표용 순수 수학 유틸 (외부 라이브러리 없음)
 */

/** 유효하지 않은 숫자면 true */
export function isInvalidNumber(x: number): boolean {
  return !Number.isFinite(x);
}

/**
 * 구간 [start, end] (포함)의 종가에 대한 단순이동평균.
 * start < 0 이거나 end >= closes.length 이면 null.
 */
export function meanSlice(closes: number[], start: number, end: number): number | null {
  if (start < 0 || end >= closes.length || start > end) return null;
  let sum = 0;
  for (let i = start; i <= end; i++) {
    const c = closes[i];
    if (isInvalidNumber(c)) return null;
    sum += c;
  }
  const n = end - start + 1;
  return sum / n;
}

/**
 * end 인덱스를 마지막 날로 하는 period일 단순이동평균 (SMA).
 * 예: period=20, end=99 → closes[80..99] 평균
 */
export function smaAt(closes: number[], period: number, end: number): number | null {
  if (period < 1 || end < period - 1 || end >= closes.length) return null;
  const start = end - period + 1;
  return meanSlice(closes, start, end);
}

/**
 * end를 마지막으로 하는 period일 종가의 표준편차 (모집단 분산: 분모 period).
 * 볼린저 밴드에서 흔히 쓰는 방식과 동일합니다.
 */
export function stdevAt(closes: number[], period: number, end: number): number | null {
  const m = smaAt(closes, period, end);
  if (m === null) return null;
  const start = end - period + 1;
  let acc = 0;
  for (let i = start; i <= end; i++) {
    const d = closes[i] - m;
    acc += d * d;
  }
  return Math.sqrt(acc / period);
}

/**
 * 14일 RSI (Wilder 스무딩) — 각 인덱스마다 RSI 값.
 * - closes[i]는 i일 종가.
 * - changes[1..] = close[i]-close[i-1]
 * - 첫 RSI는 인덱스 14부터 유효 (길이 15 이상 필요)
 */
export function computeRSISeries(closes: number[], period = 14): (number | null)[] {
  const n = closes.length;
  const rsi: (number | null)[] = Array.from({ length: n }, () => null);
  if (n < period + 1) return rsi;

  const changes: number[] = [];
  for (let i = 1; i < n; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }

  let sumGain = 0;
  let sumLoss = 0;
  for (let i = 0; i < period; i++) {
    const ch = changes[i];
    if (ch > 0) sumGain += ch;
    else sumLoss += -ch;
  }
  let avgGain = sumGain / period;
  let avgLoss = sumLoss / period;

  const rs0 = avgLoss === 0 ? (avgGain === 0 ? 0 : Infinity) : avgGain / avgLoss;
  rsi[period] = 100 - 100 / (1 + rs0);

  for (let i = period + 1; i < n; i++) {
    const ch = changes[i - 1];
    const gain = ch > 0 ? ch : 0;
    const loss = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    if (avgLoss === 0) {
      rsi[i] = avgGain === 0 ? 50 : 100;
    } else {
      const rs = avgGain / avgLoss;
      rsi[i] = 100 - 100 / (1 + rs);
    }
  }

  return rsi;
}
