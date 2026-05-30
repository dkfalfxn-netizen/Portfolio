import { NextRequest, NextResponse } from "next/server";
import { isKrxListedEquityCode, toYahooSymbol } from "@/lib/finance-symbols";
import { resolveFxWithFallback } from "@/lib/market-prices";

type ChartQuote = {
  price: number | null;
  currency: string | null;
  previousClose: number | null;
  sparkline: number[];
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

/** Yahoo chart meta에서 표시용 현재가(장중·장외·전일 종가 순으로 후보) */
function readChartHeadlinePrice(meta: unknown): number | null {
  const m = meta as Record<string, unknown> | undefined;
  if (!m) return null;
  const keys = [
    "regularMarketPrice",
    "postMarketPrice",
    "preMarketPrice",
    "chartPreviousClose",
    "previousClose",
  ] as const;
  for (const k of keys) {
    const v = m[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return null;
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

/** KRX 상품(금현물 등) 코드 판별: M + 8자리 숫자 (예: M04020000) */
function isKrxCommodity(symbol: string): boolean {
  return /^M\d{8}$/i.test(symbol.trim());
}

const emptyQuote = (): ChartQuote => ({
  price: null,
  currency: null,
  previousClose: null,
  sparkline: [],
});

/**
 * 네이버 금융 KRX 금현물 일별시세 페이지에서 최근 표준가격(KRW/g) 파싱
 */
async function fetchNaverGoldPrice(): Promise<ChartQuote> {
  try {
    const url = "https://finance.naver.com/marketindex/goldDailyQuote.nhn?page=1";
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "text/html,application/xhtml+xml",
        Referer: "https://finance.naver.com/",
      },
    });
    if (!res.ok) return emptyQuote();

    const html = await res.text();
    // 테이블의 첫 두 행(오늘, 어제)을 파싱해 현재가와 전일 종가를 가져옴
    const rows: number[] = [];
    const rowPattern =
      /<td class="date">\d{4}\.\d{2}\.\d{2}<\/td>\s*<td class="num">([\d,]+(?:\.\d+)?)<\/td>/g;
    let m: RegExpExecArray | null;
    while ((m = rowPattern.exec(html)) !== null && rows.length < 2) {
      const p = parseFloat(m[1].replace(/,/g, ""));
      if (Number.isFinite(p) && p > 0) rows.push(p);
    }

    if (rows.length === 0) return emptyQuote();

    return {
      price: rows[0],
      currency: "KRW",
      previousClose: rows.length >= 2 ? rows[1] : null,
      sparkline: [],
    };
  } catch {
    return emptyQuote();
  }
}

/** 네이버 증권 모바일 API — 6자리 한국 주식 코드 (거래소 자동 판별) */
async function fetchNaverStockPrice(code: string): Promise<ChartQuote> {
  try {
    // A458730, A0051G0 등 거래소 접두사가 붙은 경우 제거 (네이버 API는 접두 없는 코드 사용)
    const cleanCode = /^[A-Z][0-9A-Z]{6}$/i.test(code.trim()) ? code.trim().slice(1) : code.trim();
    const url = `https://m.stock.naver.com/api/stock/${encodeURIComponent(cleanCode)}/basic`;
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    });
    if (!res.ok) return emptyQuote();
    const d = await res.json() as Record<string, unknown>;
    // closePrice: "192,000" 형태 문자열
    const price = typeof d.closePrice === "string"
      ? parseFloat((d.closePrice as string).replace(/,/g, ""))
      : null;
    if (!price || !Number.isFinite(price)) return emptyQuote();
    // compareToPreviousClosePrice: 전일 대비 변동분 (예: "-7,000")
    const change = typeof d.compareToPreviousClosePrice === "string"
      ? parseFloat((d.compareToPreviousClosePrice as string).replace(/,/g, ""))
      : null;
    const previousClose = change !== null && Number.isFinite(change) ? price - change : null;
    return { price, currency: "KRW", previousClose, sparkline: [] };
  } catch {
    return emptyQuote();
  }
}

async function fetchNaverPrice(code: string): Promise<ChartQuote> {
  if (/^M040200/i.test(code)) {
    return fetchNaverGoldPrice();
  }
  return emptyQuote();
}

async function fetchVix(): Promise<number | null> {
  try {
    const chartUrl =
      "https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1m&range=1d";
    const response = await fetch(chartUrl, {
      method: "GET",
      cache: "no-store",
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!response.ok) return null;
    const data = await response.json();
    const meta = data?.chart?.result?.[0]?.meta;
    return readChartHeadlinePrice(meta);
  } catch {
    return null;
  }
}

const CNN_FEAR_GREED_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Referer: "https://edition.cnn.com/markets/fear-and-greed",
} as const;

/** CNN 페이지와 동일 출처 — rating 소문자 → UI/한글 매핑용 라벨 */
function cnnFearGreedRatingToLabel(rating: string): string {
  const u = rating.trim().toLowerCase();
  if (u === "extreme fear") return "Extreme Fear";
  if (u === "fear") return "Fear";
  if (u === "neutral") return "Neutral";
  if (u === "greed") return "Greed";
  if (u === "extreme greed") return "Extreme Greed";
  if (!rating) return "—";
  return rating.charAt(0).toUpperCase() + rating.slice(1).toLowerCase();
}

async function fetchFearGreed(): Promise<{ score: number; label: string } | null> {
  try {
    const res = await fetch(
      "https://production.dataviz.cnn.io/index/fearandgreed/graphdata",
      {
        method: "GET",
        cache: "no-store",
        headers: CNN_FEAR_GREED_HEADERS,
      },
    );
    if (!res.ok) return null;
    const j = (await res.json()) as {
      fear_and_greed?: { score?: number; rating?: string };
    };
    const fg = j.fear_and_greed;
    if (!fg || typeof fg.score !== "number" || !Number.isFinite(fg.score)) return null;
    const label = cnnFearGreedRatingToLabel(fg.rating ?? "");
    return { score: Math.round(fg.score), label };
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const symbolsParam = req.nextUrl.searchParams.get("symbols") ?? "";
  const rawSymbols = symbolsParam
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  async function fetchUsdKrwOnly(): Promise<number | null> {
    try {
      const chartUrl =
        "https://query1.finance.yahoo.com/v8/finance/chart/KRW=X?interval=1m&range=1d";
      const response = await fetch(chartUrl, {
        method: "GET",
        cache: "no-store",
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      if (!response.ok) return null;
      const data = await response.json();
      const meta = data?.chart?.result?.[0]?.meta;
      return readChartHeadlinePrice(meta);
    } catch {
      return null;
    }
  }

  async function fetchEurKrwOnly(): Promise<number | null> {
    try {
      const chartUrl =
        "https://query1.finance.yahoo.com/v8/finance/chart/EURKRW=X?interval=1m&range=1d";
      const response = await fetch(chartUrl, {
        method: "GET",
        cache: "no-store",
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      if (!response.ok) return null;
      const data = await response.json();
      const meta = data?.chart?.result?.[0]?.meta;
      return readChartHeadlinePrice(meta);
    } catch {
      return null;
    }
  }

  if (rawSymbols.length === 0) {
    const [usdKrw, eurKrw, vix, fearGreed] = await Promise.all([
      fetchUsdKrwOnly(),
      fetchEurKrwOnly(),
      fetchVix(),
      fetchFearGreed(),
    ]);
    return NextResponse.json({
      quotes: {},
      intraday: {},
      usdKrw,
      eurKrw,
      vix,
      fearGreed,
      fetchedAt: Date.now(),
    });
  }

  const commoditySymbols = rawSymbols.filter(isKrxCommodity);
  const yahooInputSymbols = rawSymbols.filter((s) => !isKrxCommodity(s));

  const mapping = yahooInputSymbols.map((symbol) => ({
    input: symbol,
    yahoo: toYahooSymbol(symbol),
  }));

  const yahooSymbols = [...new Set([...mapping.map((m) => m.yahoo), "KRW=X", "EURKRW=X"])];

  try {
    const macroPromise = Promise.all([fetchVix(), fetchFearGreed()]);
    const [quoteEntries, commodityResults] = await Promise.all([
      Promise.all(
        yahooSymbols.map(async (symbol) => {
          const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
            symbol,
          )}?interval=1m&range=1d`;
          const response = await fetch(chartUrl, {
            method: "GET",
            cache: "no-store",
            headers: { "User-Agent": "Mozilla/5.0" },
          });

          if (!response.ok) {
            return [symbol.toUpperCase(), emptyQuote()] as const;
          }

          const data = await response.json();
          const meta = data?.chart?.result?.[0]?.meta;
          const price = readChartHeadlinePrice(meta);
          const currency = typeof meta?.currency === "string" ? meta.currency : null;
          const previousClose = readPreviousClose(meta);
          const sparkline = extractSparklinePoints(data);
          return [
            symbol.toUpperCase(),
            { price, currency, previousClose, sparkline } satisfies ChartQuote,
          ] as const;
        }),
      ),
      Promise.all(
        commoditySymbols.map(async (symbol) => {
          const quote = await fetchNaverPrice(symbol);
          return [symbol, quote] as const;
        }),
      ),
    ]);

    const byYahooSymbol = new Map<string, ChartQuote>(quoteEntries);

    const quotes: Record<
      string,
      { price: number | null; currency: string | null; previousClose: number | null }
    > = {};
    const intraday: Record<string, number[]> = {};

    const krSixDigit = yahooInputSymbols.filter((s) => isKrxListedEquityCode(s));
    const naverResults = krSixDigit.length > 0
      ? await Promise.all(krSixDigit.map(async (s) => [s, await fetchNaverStockPrice(s)] as const))
      : [];
    const byNaver = new Map(naverResults);

    for (const mapItem of mapping) {
      const naverQ = byNaver.get(mapItem.input);
      const yahooQ = byYahooSymbol.get(mapItem.yahoo.toUpperCase());
      if (naverQ?.price) {
        // 네이버에서 정확히 조회된 한국 주식/ETF — 현재가는 네이버, 분봉 sparkline은 Yahoo 사용
        quotes[mapItem.input] = { price: naverQ.price, currency: "KRW", previousClose: naverQ.previousClose };
        const sl = yahooQ?.sparkline;
        if (sl && sl.length >= 2) intraday[mapItem.input] = sl;
      } else {
        // 해외주식 등 — Yahoo 결과 사용
        quotes[mapItem.input] = {
          price: yahooQ?.price ?? null,
          currency: yahooQ?.currency ?? null,
          previousClose: yahooQ?.previousClose ?? null,
        };
        const sl = yahooQ?.sparkline;
        if (sl && sl.length >= 2) intraday[mapItem.input] = sl;
      }
    }

    for (const [symbol, quote] of commodityResults) {
      quotes[symbol] = {
        price: quote.price,
        currency: quote.currency,
        previousClose: quote.previousClose,
      };
      if (quote.sparkline.length >= 2) intraday[symbol] = quote.sparkline;
    }

    const fxQuote = byYahooSymbol.get("KRW=X");
    const eurFx = byYahooSymbol.get("EURKRW=X");
    // Yahoo 환율 실패 시 frankfurter.app(ECB)으로 폴백
    const { usdKrw, eurKrw } = await resolveFxWithFallback(
      typeof fxQuote?.price === "number" ? fxQuote.price : null,
      typeof eurFx?.price === "number" ? eurFx.price : null,
    );

    const [vix, fearGreed] = await macroPromise;

    return NextResponse.json({
      quotes,
      intraday,
      usdKrw,
      eurKrw,
      vix,
      fearGreed,
      fetchedAt: Date.now(),
    });
  } catch {
    return NextResponse.json({ error: "시세 API 요청 오류" }, { status: 500 });
  }
}
