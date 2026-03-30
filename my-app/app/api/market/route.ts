import { NextRequest, NextResponse } from "next/server";

type ChartQuote = { price: number | null; currency: string | null };

/** KRX 상품(금현물 등) 코드 판별: M + 8자리 숫자 (예: M04020000) */
function isKrxCommodity(symbol: string): boolean {
  return /^M\d{8}$/i.test(symbol.trim());
}

/** 네이버 금융 API로 KRX 상품 시세 조회 */
async function fetchNaverPrice(code: string): Promise<ChartQuote> {
  try {
    const url = `https://m.stock.naver.com/api/stock/${code.toUpperCase()}/basic`;
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) return { price: null, currency: null };
    const data = await res.json();
    // closePrice는 쉼표 포함 문자열일 수 있음 (예: "127,500")
    const raw = data?.closePrice ?? data?.currentPrice ?? data?.stockEndPrice;
    const price = raw ? parseFloat(String(raw).replace(/,/g, "")) : null;
    return {
      price: Number.isFinite(price) && price !== null ? price : null,
      currency: "KRW",
    };
  } catch {
    return { price: null, currency: null };
  }
}

function toYahooSymbol(symbol: string): string {
  const normalized = symbol.trim().toUpperCase();
  // KRX:XXXXXX → XXXXXX.KS
  if (normalized.startsWith("KRX:")) {
    return `${normalized.replace("KRX:", "")}.KS`;
  }
  // 6자리 영숫자(숫자로 시작) → KOSPI(.KS) 자동 변환
  // 예: 005930, 488500, 0022T0, 0118S0, 0118Z0 등 KRX 코드 패턴
  if (/^[0-9][0-9A-Z]{5}$/.test(normalized)) {
    return `${normalized}.KS`;
  }
  // KOSDAQ 접두사 지원 (예: KQ:293490)
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

  if (rawSymbols.length === 0) {
    const usdKrw = await fetchUsdKrwOnly();
    return NextResponse.json({ quotes: {}, usdKrw, fetchedAt: Date.now() });
  }

  // KRX 상품 코드(네이버)와 일반 코드(Yahoo) 분리
  const commoditySymbols = rawSymbols.filter(isKrxCommodity);
  const yahooInputSymbols = rawSymbols.filter((s) => !isKrxCommodity(s));

  const mapping = yahooInputSymbols.map((symbol) => ({
    input: symbol,
    yahoo: toYahooSymbol(symbol),
  }));

  const yahooSymbols = [...new Set([...mapping.map((m) => m.yahoo), "KRW=X"])];

  try {
    // Yahoo Finance + 네이버 금융 병렬 요청
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
            return [symbol.toUpperCase(), { price: null, currency: null } satisfies ChartQuote] as const;
          }

          const data = await response.json();
          const meta = data?.chart?.result?.[0]?.meta;
          const price =
            typeof meta?.regularMarketPrice === "number" ? meta.regularMarketPrice : null;
          const currency = typeof meta?.currency === "string" ? meta.currency : null;
          return [symbol.toUpperCase(), { price, currency } satisfies ChartQuote] as const;
        }),
      ),
      // KRX 상품은 네이버 금융에서 조회
      Promise.all(
        commoditySymbols.map(async (symbol) => {
          const quote = await fetchNaverPrice(symbol);
          return [symbol, quote] as const;
        }),
      ),
    ]);

    const byYahooSymbol = new Map<string, ChartQuote>(quoteEntries);

    const quotes: Record<string, { price: number | null; currency: string | null }> = {};

    // Yahoo Finance 결과 매핑
    for (const mapItem of mapping) {
      const quote = byYahooSymbol.get(mapItem.yahoo.toUpperCase());
      quotes[mapItem.input] = {
        price: quote?.price ?? null,
        currency: quote?.currency ?? null,
      };
    }

    // 네이버 금융 결과 매핑 (KRX 상품)
    for (const [symbol, quote] of commodityResults) {
      quotes[symbol] = quote;
    }

    const fxQuote = byYahooSymbol.get("KRW=X");
    const usdKrw = typeof fxQuote?.price === "number" ? fxQuote.price : null;

    return NextResponse.json({
      quotes,
      usdKrw,
      fetchedAt: Date.now(),
    });
  } catch {
    return NextResponse.json({ error: "시세 API 요청 오류" }, { status: 500 });
  }
}
