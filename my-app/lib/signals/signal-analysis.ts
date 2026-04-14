import type { DailyPrice, TradeSignal } from "./types";
import { calculateBollingerSignal } from "./bollinger";
import { calculateMACrossoverSignal } from "./ma-crossover";
import { calculateRSISignal } from "./rsi";
import { calculateVolumeSignal } from "./volume";
import { computeRSISeries, smaAt, stdevAt } from "./math";

const SHORT_MA = 20;
const LONG_MA = 60;
const RSI_PERIOD = 14;
const BB_PERIOD = 20;
const BB_MULT = 2;
const VOL_PERIOD = 20;
const VOL_SPIKE = 1.5;

export type SignalChartPoint = {
  date: string;
  close: number;
  sma20: number | null;
  sma60: number | null;
  bbUpper: number | null;
  bbMid: number | null;
  bbLower: number | null;
  rsi: number | null;
  volume: number;
  volAvg: number | null;
};

export type IndicatorExplain = {
  signal: TradeSignal;
  title: string;
  summary: string;
  detail: string;
};

export type SignalAnalysisResult = {
  final: TradeSignal;
  ma: TradeSignal;
  rsi: TradeSignal;
  bb: TradeSignal;
  vol: TradeSignal;
  buyVotes: number;
  sellVotes: number;
  finalSummary: string;
  chartPoints: SignalChartPoint[];
  maExplain: IndicatorExplain;
  rsiExplain: IndicatorExplain;
  bbExplain: IndicatorExplain;
  volExplain: IndicatorExplain;
};

function bollingerAt(closes: number[], end: number): { upper: number; lower: number; mid: number } | null {
  const mid = smaAt(closes, BB_PERIOD, end);
  const sd = stdevAt(closes, BB_PERIOD, end);
  if (mid === null || sd === null) return null;
  return {
    mid,
    upper: mid + BB_MULT * sd,
    lower: mid - BB_MULT * sd,
  };
}

/**
 * 일봉 데이터로 시그널·차트 시리즈·한국어 설명을 생성합니다.
 */
export function buildSignalAnalysis(prices: DailyPrice[]): SignalAnalysisResult | null {
  if (!Array.isArray(prices) || prices.length === 0) return null;

  const ma = calculateMACrossoverSignal(prices);
  const rsiSig = calculateRSISignal(prices);
  const bb = calculateBollingerSignal(prices);
  const vol = calculateVolumeSignal(prices);
  const buyVotes = [ma, rsiSig, bb, vol].filter((s) => s === "BUY").length;
  const sellVotes = [ma, rsiSig, bb, vol].filter((s) => s === "SELL").length;
  const final: TradeSignal =
    buyVotes > sellVotes ? "BUY" : sellVotes > buyVotes ? "SELL" : "HOLD";

  const closes = prices.map((p) => p.close);
  const rsiSeries = computeRSISeries(closes, RSI_PERIOD);
  const n = closes.length;

  const chartPoints: SignalChartPoint[] = [];
  const displayStart = Math.max(0, n - 120);
  for (let j = displayStart; j < n; j++) {
    const bbB = bollingerAt(closes, j);
    let volAvg: number | null = null;
    if (j >= VOL_PERIOD) {
      let sum = 0;
      let ok = true;
      for (let i = j - VOL_PERIOD; i < j; i++) {
        const v = prices[i]?.volume;
        if (!Number.isFinite(v) || v! < 0) {
          ok = false;
          break;
        }
        sum += v!;
      }
      volAvg = ok ? sum / VOL_PERIOD : null;
    }
    chartPoints.push({
      date: prices[j]!.date,
      close: closes[j]!,
      sma20: smaAt(closes, SHORT_MA, j),
      sma60: smaAt(closes, LONG_MA, j),
      bbUpper: bbB?.upper ?? null,
      bbMid: bbB?.mid ?? null,
      bbLower: bbB?.lower ?? null,
      rsi: rsiSeries[j] ?? null,
      volume: Number.isFinite(prices[j]!.volume) ? prices[j]!.volume : 0,
      volAvg,
    });
  }

  const maExplain = explainMA(prices, closes, ma);
  const rsiExplain = explainRSI(prices, closes, rsiSeries, rsiSig);
  const bbExplain = explainBB(prices, closes, bb);
  const volExplain = explainVol(prices, vol);

  let finalSummary = "";
  if (final === "BUY") {
    finalSummary = `네 지표 중 매수(BUY) ${buyVotes}개, 매도(SELL) ${sellVotes}개로 다수결이 매수입니다. 참고용이며, 투자 판단은 본인 책임입니다.`;
  } else if (final === "SELL") {
    finalSummary = `네 지표 중 매도(SELL) ${sellVotes}개, 매수(BUY) ${buyVotes}개로 다수결이 매도입니다. 참고용이며, 투자 판단은 본인 책임입니다.`;
  } else {
    finalSummary = `매수·매도 조건이 충돌하거나(동수) 네 지표 모두 관망(HOLD)에 가깝습니다. 아래 각 항목 근거를 확인하세요.`;
  }

  return {
    final,
    ma,
    rsi: rsiSig,
    bb,
    vol,
    buyVotes,
    sellVotes,
    finalSummary,
    chartPoints,
    maExplain,
    rsiExplain,
    bbExplain,
    volExplain,
  };
}

function explainMA(prices: DailyPrice[], closes: number[], signal: TradeSignal): IndicatorExplain {
  const title = "이동평균(20일·60일) 교차";
  if (closes.length < LONG_MA + 2) {
    return {
      signal: "HOLD",
      title,
      summary: "데이터 부족",
      detail: `골든/데드크로스 판별에는 최소 ${LONG_MA + 2}거래일 일봉이 필요합니다. 현재 ${prices.length}일치입니다.`,
    };
  }
  const prev = closes.length - 2;
  const last = closes.length - 1;
  const s20p = smaAt(closes, SHORT_MA, prev);
  const s60p = smaAt(closes, LONG_MA, prev);
  const s20c = smaAt(closes, SHORT_MA, last);
  const s60c = smaAt(closes, LONG_MA, last);
  if (s20p === null || s60p === null || s20c === null || s60c === null) {
    return {
      signal: "HOLD",
      title,
      summary: "계산 불가",
      detail: "이동평균을 계산할 수 없습니다.",
    };
  }
  const dPrev = prices[prev]!.date;
  const dLast = prices[last]!.date;
  const detail =
    `• 기준: 전일(${dPrev}) 20일선 ${fmtNum(s20p)}, 60일선 ${fmtNum(s60p)} → 당일(${dLast}) 20일선 ${fmtNum(s20c)}, 60일선 ${fmtNum(s60c)}\n` +
    `• 매수(BUY): 전일까지 20≤60 이었는데 당일 20>60 (골든크로스)\n` +
    `• 매도(SELL): 전일까지 20≥60 이었는데 당일 20<60 (데드크로스)\n` +
    `• 그 외는 HOLD`;

  if (signal === "BUY") {
    return {
      signal,
      title,
      summary: "골든크로스로 매수 신호",
      detail,
    };
  }
  if (signal === "SELL") {
    return {
      signal,
      title,
      summary: "데드크로스로 매도 신호",
      detail,
    };
  }
  return {
    signal: "HOLD",
    title,
    summary: "단기·중기 이평 교차 신호 없음",
    detail,
  };
}

function explainRSI(
  prices: DailyPrice[],
  closes: number[],
  rsiSeries: (number | null)[],
  signal: TradeSignal,
): IndicatorExplain {
  const title = "RSI(14)";
  if (closes.length < RSI_PERIOD + 1) {
    return {
      signal: "HOLD",
      title,
      summary: "데이터 부족",
      detail: `RSI 비교에는 최소 ${RSI_PERIOD + 1}거래일이 필요합니다.`,
    };
  }
  const prevR = rsiSeries[closes.length - 2];
  const lastR = rsiSeries[closes.length - 1];
  if (prevR === null || lastR === null) {
    return { signal: "HOLD", title, summary: "RSI 계산 불가", detail: "" };
  }
  const dPrev = prices[closes.length - 2]!.date;
  const dLast = prices[closes.length - 1]!.date;
  const detail =
    `• 전일(${dPrev}) RSI ${prevR.toFixed(1)}, 당일(${dLast}) RSI ${lastR.toFixed(1)} (과매도 30 / 과매수 70 기준)\n` +
    `• 매수: 전일 RSI≤30 이고 당일 RSI>30 (과매도권에서 상향 탈출)\n` +
    `• 매도: 전일 RSI≥70 이고 당일 RSI<70 (과매수권에서 하향 이탈)`;

  if (signal === "BUY") {
    return { signal, title, summary: "과매도권 상향 이탈로 매수 신호", detail };
  }
  if (signal === "SELL") {
    return { signal, title, summary: "과매수권 하향 이탈로 매도 신호", detail };
  }
  return {
    signal: "HOLD",
    title,
    summary: `RSI ${lastR.toFixed(1)} — 교차 조건 미충족`,
    detail,
  };
}

function explainBB(prices: DailyPrice[], closes: number[], signal: TradeSignal): IndicatorExplain {
  const title = "볼린저 밴드(20, 2σ)";
  if (closes.length < BB_PERIOD + 1) {
    return {
      signal: "HOLD",
      title,
      summary: "데이터 부족",
      detail: `밴드 판별에는 최소 ${BB_PERIOD + 1}거래일이 필요합니다.`,
    };
  }
  const prev = closes.length - 2;
  const last = closes.length - 1;
  const bP = bollingerAt(closes, prev);
  const bL = bollingerAt(closes, last);
  if (!bP || !bL) {
    return { signal: "HOLD", title, summary: "밴드 계산 불가", detail: "" };
  }
  const cPrev = closes[prev]!;
  const cLast = closes[last]!;
  const dPrev = prices[prev]!.date;
  const dLast = prices[last]!.date;
  const detail =
    `• 전일(${dPrev}) 종가 ${fmtNum(cPrev)} / 상단 ${fmtNum(bP.upper)} · 하단 ${fmtNum(bP.lower)}\n` +
    `• 당일(${dLast}) 종가 ${fmtNum(cLast)} / 상단 ${fmtNum(bL.upper)} · 하단 ${fmtNum(bL.lower)}\n` +
    `• 매수: 전일 종가가 하단 아래였다가 당일 하단 이상으로 반등\n` +
    `• 매도: 전일 종가가 상단 위였다가 당일 상단 이하로 되돌림`;

  if (signal === "BUY") {
    return { signal, title, summary: "하단 이탈 후 반등으로 매수 신호", detail };
  }
  if (signal === "SELL") {
    return { signal, title, summary: "상단 돌파 후 되돌림으로 매도 신호", detail };
  }
  return {
    signal: "HOLD",
    title,
    summary: "밴드 돌파·되돌림 패턴 없음",
    detail,
  };
}

function explainVol(prices: DailyPrice[], signal: TradeSignal): IndicatorExplain {
  const title = "거래량 스파이크";
  if (prices.length < VOL_PERIOD + 1) {
    return {
      signal: "HOLD",
      title,
      summary: "데이터 부족",
      detail: `전일까지 ${VOL_PERIOD}일 평균 거래량과 비교하려면 최소 ${VOL_PERIOD + 1}일치가 필요합니다.`,
    };
  }
  const n = prices.length;
  const last = prices[n - 1]!;
  const prev = prices[n - 2]!;
  let sumVol = 0;
  for (let i = n - 1 - VOL_PERIOD; i <= n - 2; i++) {
    sumVol += prices[i]!.volume;
  }
  const avgVol = sumVol / VOL_PERIOD;
  const ratio = avgVol > 0 ? last.volume / avgVol : 0;
  const detail =
    `• 전일 종가 ${fmtNum(prev.close)} → 당일 종가 ${fmtNum(last.close)}\n` +
    `• 당일 거래량 ${fmtVol(last.volume)} / 전일까지 ${VOL_PERIOD}일 평균 ${fmtVol(avgVol)} (당일/평균 ${ratio.toFixed(2)}배)\n` +
    `• 스파이크 기준: 당일 거래량 ≥ 평균×${VOL_SPIKE}\n` +
    `• 스파이크일 때 종가가 전일보다 상승이면 BUY, 하락이면 SELL, 그 외 HOLD`;

  if (signal === "BUY") {
    return {
      signal,
      title,
      summary: `거래량 ${ratio.toFixed(2)}배 + 종가 상승`,
      detail,
    };
  }
  if (signal === "SELL") {
    return {
      signal,
      title,
      summary: `거래량 ${ratio.toFixed(2)}배 + 종가 하락`,
      detail,
    };
  }
  return {
    signal: "HOLD",
    title,
    summary: ratio >= VOL_SPIKE ? "스파이크였으나 등락 조건 없음" : "평균 대비 거래량 일반 수준",
    detail,
  };
}

function fmtNum(x: number): string {
  if (x >= 1000) return x.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return x.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function fmtVol(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}
