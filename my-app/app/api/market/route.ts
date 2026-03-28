import { NextRequest, NextResponse } from "next/server";

type ChartQuote = { price: number | null; currency: string | null };

function toYahooSymbol(symbol: string): string {
  const normalized = symbol.trim().toUpperCase();
  if (normalized.startsWith("KRX:")) {
    const code = normalized.replace("KRX:", "");
    return `${code}.KS`;
  }
  return normalized;
}

export async function GET(req: NextRequest) {
  const symbolsParam = req.nextUrl.searchParams.get("symbols") ?? "";
  const rawSymbols = symbolsParam
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (rawSymbols.length === 0) {
    return NextResponse.json({ quotes: {}, usdKrw: null, fetchedAt: Date.now() });
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
