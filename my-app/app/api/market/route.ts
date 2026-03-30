import { NextRequest, NextResponse } from "next/server";

type ChartQuote = { price: number | null; currency: string | null };

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

  const mapping = rawSymbols.map((symbol) => ({
    input: symbol,
    yahoo: toYahooSymbol(symbol),
  }));

  const yahooSymbols = [...new Set([...mapping.map((m) => m.yahoo), "KRW=X"])];

  try {
    const quoteEntries = await Promise.all(
      yahooSymbols.map(async (symbol) => {
        const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
          symbol,
        )}?interval=1m&range=1d`;
        const response = await fetch(chartUrl, {
          method: "GET",
          cache: "no-store",
          headers: {
            "User-Agent": "Mozilla/5.0",
          },
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
    );

    const byYahooSymbol = new Map<string, ChartQuote>(quoteEntries);

    const quotes: Record<string, { price: number | null; currency: string | null }> = {};
    for (const mapItem of mapping) {
      const quote = byYahooSymbol.get(mapItem.yahoo.toUpperCase());
      quotes[mapItem.input] = {
        price: quote?.price ?? null,
        currency: quote?.currency ?? null,
      };
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
