/**
 * Yahoo v8 chart(1분봉·프리/애프터 포함) 기반 미국 등 해외 종목 시세.
 * 대시보드(/api/market)와 텔레그램 브리핑(/api/alert/kakao-price-move)이 같은 규칙을 쓰도록 공유한다.
 */

export type MarketState = "REGULAR" | "PRE" | "POST" | "POSTPOST" | "PREPRE" | "CLOSED" | null;

export type ChartQuote = {
  price: number | null;
  currency: string | null;
  previousClose: number | null;
  sparkline: number[];
  marketState: MarketState;
};

function readPreviousClose(meta: unknown): number | null {
  const m = meta as Record<string, unknown> | undefined;
  if (!m) return null;
  for (const k of ["chartPreviousClose", "previousClose"]) {
    const v = m[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

/**
 * currentTradingPeriod 타임스탬프로 현재 세션 판별.
 * Yahoo meta에 marketState 필드가 없어서 직접 계산.
 */
function resolveMarketState(meta: unknown): MarketState {
  const m = meta as Record<string, unknown> | undefined;
  if (!m) return null;
  // Yahoo가 여전히 marketState를 내려주면 그대로 사용
  if (typeof m.marketState === "string") return m.marketState as MarketState;

  const periods = m.currentTradingPeriod as
    | { pre?: { start: number; end: number }; regular?: { start: number; end: number }; post?: { start: number; end: number } }
    | undefined;
  if (!periods) return null;

  const now = Date.now() / 1000;
  if (periods.pre && now >= periods.pre.start && now < periods.pre.end) return "PRE";
  if (periods.regular && now >= periods.regular.start && now < periods.regular.end) return "REGULAR";
  if (periods.post && now >= periods.post.start && now < periods.post.end) return "POST";
  if (periods.regular && now < periods.regular.start) return "PREPRE";
  if (periods.post && now >= periods.post.end) return "POSTPOST";
  return "CLOSED";
}

/**
 * includePrePost=true로 받은 chart 데이터에서 candle 배열의 마지막 유효가 추출.
 * 프리/애프터장 포함 가장 최신 체결가.
 */
export function extractLastCandlePrice(data: unknown): number | null {
  const result = (data as { chart?: { result?: unknown[] } })?.chart?.result?.[0] as
    | { indicators?: { quote?: Array<{ close?: unknown[] }> } }
    | undefined;
  const closes = result?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(closes)) return null;
  for (let i = closes.length - 1; i >= 0; i--) {
    const v = closes[i];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

/** Yahoo chart meta + candle 데이터로 표시용 현재가 결정 */
export function readChartHeadlinePrice(
  meta: unknown,
  lastCandlePrice: number | null,
): { price: number | null; marketState: MarketState } {
  const m = meta as Record<string, unknown> | undefined;
  if (!m) return { price: null, marketState: null };

  const state = resolveMarketState(meta);
  const num = (k: string) => {
    const v = m[k];
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
  };
  const regularPrice = num("regularMarketPrice") ?? num("chartPreviousClose") ?? num("previousClose");
  const postMarketPrice = num("postMarketPrice");
  const preMarketPrice = num("preMarketPrice");

  if (state === "PRE") {
    const price = preMarketPrice ?? lastCandlePrice ?? regularPrice;
    return { price, marketState: state };
  }
  if (state === "POST" || state === "POSTPOST" || state === "CLOSED" || state === "PREPRE") {
    const price = postMarketPrice ?? lastCandlePrice ?? regularPrice;
    return { price, marketState: state };
  }
  return { price: regularPrice, marketState: state };
}

type ChartCandle = { t: number; c: number };

/** chart 응답의 (타임스탬프, 종가) 유효 봉 목록(오래된 순) */
function extractCandles(data: unknown): ChartCandle[] {
  const result = (data as { chart?: { result?: unknown[] } })?.chart?.result?.[0] as
    | { timestamp?: unknown[]; indicators?: { quote?: Array<{ close?: unknown[] }> } }
    | undefined;
  const ts = result?.timestamp;
  const closes = result?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(ts) || !Array.isArray(closes)) return [];
  const out: ChartCandle[] = [];
  for (let i = 0; i < Math.min(ts.length, closes.length); i++) {
    const t = ts[i];
    const c = closes[i];
    if (typeof t === "number" && typeof c === "number" && Number.isFinite(c) && c > 0) out.push({ t, c });
  }
  return out;
}

function downsample(nums: number[], maxPts = 100): number[] {
  if (nums.length <= maxPts) return nums;
  const step = Math.ceil(nums.length / maxPts);
  const out: number[] = [];
  for (let i = 0; i < nums.length; i += step) out.push(nums[i]!);
  if (out[out.length - 1] !== nums[nums.length - 1]) out.push(nums[nums.length - 1]!);
  return out;
}

/**
 * 프리장(정규장 개장 전) 시세 보정.
 * Yahoo는 개장 전 range=1d 요청에 전 거래일 봉을 주는 경우가 있어,
 * "마지막 봉 = 어제 애프터 종가", "chartPreviousClose = 그저께 종가"가 되면서
 * 프리장 등락률 대신 어제 등락률이 표시되던 문제가 있었다.
 *  - 기준가: 오늘 정규장 시작 전에 확정된 regularMarketPrice(= 직전 거래일 종가)
 *  - 현재가: preMarketPrice → 오늘 프리장(pre.start 이후) 마지막 봉(없으면 range=2d 재조회)
 *           → 프리장 체결이 아직 없으면 직전 종가(변동 0)
 * 판단 근거가 부족하면 null(기존 로직 유지).
 */
async function resolvePreMarketQuote(
  symbol: string,
  meta: unknown,
  data: unknown,
): Promise<{ price: number; previousClose: number | null; sparkline: number[] } | null> {
  const m = meta as Record<string, unknown> | undefined;
  if (!m) return null;
  const num = (k: string) => {
    const v = m[k];
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
  };
  const periods = m.currentTradingPeriod as
    | { pre?: { start: number; end: number }; regular?: { start: number; end: number } }
    | undefined;
  const preStart = periods?.pre?.start;
  const regularStart = periods?.regular?.start;
  if (typeof preStart !== "number" || typeof regularStart !== "number") return null;

  const regularPrice = num("regularMarketPrice");
  const regularTime = m.regularMarketTime;
  // 직전 거래일 종가: regularMarketPrice 가 오늘 정규장 시작 전에 찍힌 값일 때만 신뢰
  const lastClose =
    regularPrice !== null && typeof regularTime === "number" && regularTime < regularStart ? regularPrice : null;

  let todayCandles = extractCandles(data).filter((k) => k.t >= preStart);
  if (todayCandles.length === 0) {
    try {
      const res = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=2d&includePrePost=true`,
        { method: "GET", cache: "no-store", headers: { "User-Agent": "Mozilla/5.0" } },
      );
      if (res.ok) todayCandles = extractCandles(await res.json()).filter((k) => k.t >= preStart);
    } catch {
      /* 무시: 아래 폴백 */
    }
  }

  const lastTodayCandle = todayCandles.length > 0 ? todayCandles[todayCandles.length - 1]!.c : null;
  const price = num("preMarketPrice") ?? lastTodayCandle ?? lastClose;
  if (price === null) return null;
  return {
    price,
    previousClose: lastClose,
    sparkline: downsample(todayCandles.map((k) => k.c)),
  };
}

function extractSparklinePoints(data: unknown): number[] {
  const result = (data as { chart?: { result?: unknown[] } })?.chart?.result?.[0] as
    | { indicators?: { quote?: Array<{ close?: unknown[] }> } }
    | undefined;
  const closes = result?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(closes)) return [];
  const nums = closes.filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  if (nums.length <= 1) return nums;
  const maxPts = 100;
  if (nums.length <= maxPts) return nums;
  const step = Math.ceil(nums.length / maxPts);
  const out: number[] = [];
  for (let i = 0; i < nums.length; i += step) out.push(nums[i]!);
  if (out[out.length - 1] !== nums[nums.length - 1]) out.push(nums[nums.length - 1]!);
  return out;
}

/** 심볼 1개 chart 조회 → 현재가·전일종가·세션·sparkline (프리장 보정 포함). 실패 시 null. */
export async function fetchYahooChartQuote(symbol: string): Promise<ChartQuote | null> {
  const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol,
  )}?interval=1m&range=1d&includePrePost=true`;
  const response = await fetch(chartUrl, {
    method: "GET",
    cache: "no-store",
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  if (!response.ok) return null;

  const data = await response.json();
  const meta = data?.chart?.result?.[0]?.meta;
  const lastCandle = extractLastCandlePrice(data);
  const headline = readChartHeadlinePrice(meta, lastCandle);
  let price = headline.price;
  const marketState = headline.marketState;
  const currency = typeof meta?.currency === "string" ? meta.currency : null;
  let previousClose = readPreviousClose(meta);
  let sparkline = extractSparklinePoints(data);
  if (marketState === "PRE") {
    const pre = await resolvePreMarketQuote(symbol, meta, data);
    if (pre) {
      price = pre.price;
      if (pre.previousClose !== null) previousClose = pre.previousClose;
      if (pre.sparkline.length >= 2) sparkline = pre.sparkline;
    }
  }
  return { price, currency, previousClose, sparkline, marketState };
}
