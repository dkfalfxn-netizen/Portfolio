import { NextRequest, NextResponse } from "next/server";

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
    const match = html.match(
      /<td class="date">\d{4}\.\d{2}\.\d{2}<\/td>\s*<td class="num">([\d,]+(?:\.\d+)?)<\/td>/,
    );
    if (!match) return emptyQuote();

    const price = parseFloat(match[1].replace(/,/g, ""));
    return {
      price: Number.isFinite(price) ? price : null,
      currency: "KRW",
      previousClose: null,
      sparkline: [],
    };
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

function toYahooSymbol(symbol: string): string {
  const normalized = symbol.trim().toUpperCase();
  if (normalized.startsWith("KRX:")) {
    return `${normalized.replace("KRX:", "")}.KS`;
  }
  if (/^[0-9][0-9A-Z]{5}$/.test(normalized)) {
    return `${normalized}.KS`;
  }
  if (normalized.startsWith("KQ:")) {
    return `${normalized.replace("KQ:", "")}.KQ`;
  }
  return normalized;
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
      const price =
        typeof meta?.regularMarketPrice === "number" ? meta.regularMarketPrice : null;
      return price;
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
      const price =
        typeof meta?.regularMarketPrice === "number" ? meta.regularMarketPrice : null;
      return price;
    } catch {
      return null;
    }
  }

  if (rawSymbols.length === 0) {
    const [usdKrw, eurKrw] = await Promise.all([fetchUsdKrwOnly(), fetchEurKrwOnly()]);
    return NextResponse.json({
      quotes: {},
      intraday: {},
      usdKrw,
      eurKrw,
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
          const price =
            typeof meta?.regularMarketPrice === "number" ? meta.regularMarketPrice : null;
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

    for (const mapItem of mapping) {
      const quote = byYahooSymbol.get(mapItem.yahoo.toUpperCase());
      quotes[mapItem.input] = {
        price: quote?.price ?? null,
        currency: quote?.currency ?? null,
        previousClose: quote?.previousClose ?? null,
      };
      const sl = quote?.sparkline;
      if (sl && sl.length >= 2) intraday[mapItem.input] = sl;
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
    const usdKrw = typeof fxQuote?.price === "number" ? fxQuote.price : null;
    const eurFx = byYahooSymbol.get("EURKRW=X");
    const eurKrw = typeof eurFx?.price === "number" ? eurFx.price : null;

    return NextResponse.json({
      quotes,
      intraday,
      usdKrw,
      eurKrw,
      fetchedAt: Date.now(),
    });
  } catch {
    return NextResponse.json({ error: "시세 API 요청 오류" }, { status: 500 });
  }
}
