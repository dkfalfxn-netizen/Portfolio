import { toYahooSymbol } from "@/lib/finance-symbols";

export type SignalVerdict = "BUY" | "HOLD" | "SELL" | "WATCH";

export type FourSignalsResult = {
  symbol: string;
  name: string;
  ma: SignalVerdict;
  rsi: SignalVerdict;
  bb: SignalVerdict;
  vol: SignalVerdict;
  overall: "STRONG_BUY" | "BUY" | "HOLD" | "CAUTION" | "WAIT";
  summaryKo: string;
  lastClose: number | null;
  sma20: number | null;
  rsi14: number | null;
  error?: string;
};

function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/** Wilder RSI (마지막 봉 기준) */
function rsiWilder(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) avgGain += ch;
    else avgLoss -= ch;
  }
  avgGain /= period;
  avgLoss /= period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function bollinger(
  closes: number[],
  period = 20,
  mult = 2,
): { mid: number; upper: number; lower: number } | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const variance =
    slice.reduce((s, x) => s + (x - mid) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return { mid, upper: mid + mult * sd, lower: mid - mult * sd };
}

type YahooChartBar = { close: number; volume: number };

async function fetchYahooDailyBars(symbol: string, range: "3mo" | "6mo" = "6mo"): Promise<YahooChartBar[] | null> {
  const y = toYahooSymbol(symbol.trim());
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}?interval=1d&range=${range}`;
    const res = await fetch(url, { cache: "no-store", headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    const chart = data.chart as Record<string, unknown> | undefined;
    const resultsArr = chart?.result as unknown[] | undefined;
    const result0 = resultsArr?.[0] as Record<string, unknown> | undefined;
    const indicators = result0?.indicators as Record<string, unknown> | undefined;
    const quotes = indicators?.quote as unknown[] | undefined;
    const quote0 = quotes?.[0] as Record<string, unknown> | undefined;
    const closes = quote0?.close as Array<number | null | undefined> | undefined;
    const volumes = quote0?.volume as Array<number | null | undefined> | undefined;
    if (!closes || !volumes || closes.length === 0) return null;
    const bars: YahooChartBar[] = [];
    for (let i = 0; i < closes.length; i++) {
      const c = closes[i];
      const v = volumes[i];
      if (typeof c === "number" && Number.isFinite(c) && c > 0) {
        bars.push({
          close: c,
          volume: typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0,
        });
      }
    }
    return bars.length >= 25 ? bars : null;
  } catch {
    return null;
  }
}

function verdictMA(close: number, sma20: number): SignalVerdict {
  if (close > sma20 * 1.005) return "BUY";
  if (close < sma20 * 0.995) return "SELL";
  return "HOLD";
}

function verdictRSI(rsi: number): SignalVerdict {
  if (rsi < 32) return "BUY";
  if (rsi > 68) return "SELL";
  return "HOLD";
}

function verdictBB(close: number, upper: number, lower: number): SignalVerdict {
  if (close <= lower) return "BUY";
  if (close >= upper) return "SELL";
  return "HOLD";
}

function verdictVol(lastVol: number, volSma20: number): SignalVerdict {
  if (volSma20 <= 0) return "HOLD";
  if (lastVol > volSma20 * 1.25) return "BUY";
  if (lastVol < volSma20 * 0.75) return "WATCH";
  return "HOLD";
}

function overallFrom(
  ma: SignalVerdict,
  rsi: SignalVerdict,
  bb: SignalVerdict,
  vol: SignalVerdict,
): FourSignalsResult["overall"] {
  const buy = [ma, rsi, bb, vol].filter((v) => v === "BUY").length;
  const sell = [ma, rsi, bb, vol].filter((v) => v === "SELL").length;
  if (sell >= 2) return "CAUTION";
  if (buy >= 3) return "STRONG_BUY";
  if (buy >= 2) return "BUY";
  if (buy === 1 && sell === 0) return "WAIT";
  return "HOLD";
}

function summaryKo(overall: FourSignalsResult["overall"]): string {
  switch (overall) {
    case "STRONG_BUY":
      return "다수 지표가 매수 우위 — 분할·감시 참고";
    case "BUY":
      return "일부 매수 신호 — 추가 확인 권장";
    case "WAIT":
      return "방향 대기 — 관망·소량만 참고";
    case "CAUTION":
      return "과열·하락 신호 복합 — 신중히";
    case "HOLD":
    default:
      return "뚜렷한 매수 타이밍 아님 — 보류";
  }
}

export async function analyzeFourSignals(symbol: string, displayName: string): Promise<FourSignalsResult> {
  const bars = await fetchYahooDailyBars(symbol);
  if (!bars || bars.length < 25) {
    return {
      symbol,
      name: displayName,
      ma: "HOLD",
      rsi: "HOLD",
      bb: "HOLD",
      vol: "HOLD",
      overall: "HOLD",
      summaryKo: "차트 데이터 부족",
      lastClose: null,
      sma20: null,
      rsi14: null,
      error: "Yahoo 일봉 데이터를 가져오지 못했습니다.",
    };
  }
  const closes = bars.map((b) => b.close);
  const vols = bars.map((b) => b.volume);
  const lastClose = closes[closes.length - 1]!;
  const s20 = sma(closes, 20);
  const rsi14 = rsiWilder(closes, 14);
  const bb = bollinger(closes, 20, 2);
  const volSma20 = sma(vols, 20);
  const lastVol = vols[vols.length - 1] ?? 0;

  if (s20 === null || rsi14 === null || bb === null || volSma20 === null) {
    return {
      symbol,
      name: displayName,
      ma: "HOLD",
      rsi: "HOLD",
      bb: "HOLD",
      vol: "HOLD",
      overall: "HOLD",
      summaryKo: "지표 계산 불가",
      lastClose,
      sma20: s20,
      rsi14,
      error: "기간 부족",
    };
  }

  const ma = verdictMA(lastClose, s20);
  const rsi = verdictRSI(rsi14);
  const bbV = verdictBB(lastClose, bb.upper, bb.lower);
  const volV = verdictVol(lastVol, volSma20);
  const overall = overallFrom(ma, rsi, bbV, volV);

  return {
    symbol,
    name: displayName,
    ma,
    rsi,
    bb: bbV,
    vol: volV,
    overall,
    summaryKo: summaryKo(overall),
    lastClose,
    sma20: s20,
    rsi14,
  };
}
