/**
 * 서버 사이드에서 시세를 조회하는 공유 유틸리티.
 * /api/market 라우트와 크론 작업 모두에서 사용합니다.
 */

export type PriceQuote = {
  price: number | null;
  currency: string | null;
};

export type PricesResult = {
  quotes: Record<string, PriceQuote>;
  usdKrw: number | null;
  eurKrw: number | null;
};

const YAHOO_INPUT_ALIASES: Record<string, string> = {
  RMS: "RMS.PA",
};

export function isKrxCommodity(symbol: string): boolean {
  return /^M\d{8}$/i.test(symbol.trim());
}

export function toYahooSymbol(symbol: string): string {
  const normalized = symbol.trim().toUpperCase();
  const aliased = YAHOO_INPUT_ALIASES[normalized];
  if (aliased) return aliased;
  if (normalized.startsWith("KRX:")) return `${normalized.replace("KRX:", "")}.KS`;
  if (/^[0-9][0-9A-Z]{5}$/.test(normalized)) return `${normalized}.KS`;
  if (normalized.startsWith("KQ:")) return `${normalized.replace("KQ:", "")}.KQ`;
  return normalized;
}

async function fetchYahooPrice(yahooSymbol: string): Promise<PriceQuote> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1m&range=1d`;
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) return { price: null, currency: null };
    const data = await res.json() as { chart?: { result?: unknown[] } };
    const meta = data?.chart?.result?.[0] as Record<string, unknown> | undefined;
    const priceKeys = ["regularMarketPrice", "postMarketPrice", "preMarketPrice", "chartPreviousClose", "previousClose"] as const;
    let price: number | null = null;
    for (const k of priceKeys) {
      const v = meta?.[k];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) { price = v; break; }
    }
    const currency = typeof meta?.currency === "string" ? meta.currency : null;
    return { price, currency };
  } catch {
    return { price: null, currency: null };
  }
}

async function fetchNaverGoldPrice(): Promise<PriceQuote> {
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
    if (!res.ok) return { price: null, currency: null };
    const html = await res.text();
    const match = html.match(
      /<td class="date">\d{4}\.\d{2}\.\d{2}<\/td>\s*<td class="num">([\d,]+(?:\.\d+)?)<\/td>/,
    );
    if (!match) return { price: null, currency: null };
    const price = parseFloat(match[1].replace(/,/g, ""));
    return { price: Number.isFinite(price) ? price : null, currency: "KRW" };
  } catch {
    return { price: null, currency: null };
  }
}

/**
 * 심볼 배열에 대해 현재가를 일괄 조회합니다.
 * USD/KRW, EUR/KRW 환율도 함께 반환합니다.
 */
export async function fetchPrices(inputSymbols: string[]): Promise<PricesResult> {
  const unique = [...new Set(inputSymbols.map((s) => s.trim()).filter(Boolean))];
  const commodities = unique.filter(isKrxCommodity);
  const yahooInputs = unique.filter((s) => !isKrxCommodity(s));

  const mapping = yahooInputs.map((s) => ({ input: s, yahoo: toYahooSymbol(s) }));
  const yahooSet = [...new Set([...mapping.map((m) => m.yahoo), "KRW=X", "EURKRW=X"])];

  const [yahooResults, commodityResults] = await Promise.all([
    Promise.all(yahooSet.map(async (sym) => [sym.toUpperCase(), await fetchYahooPrice(sym)] as const)),
    Promise.all(commodities.map(async (sym) => {
      const q = /^M040200/i.test(sym) ? await fetchNaverGoldPrice() : { price: null, currency: null };
      return [sym, q] as const;
    })),
  ]);

  const byYahoo = new Map<string, PriceQuote>(yahooResults);
  const quotes: Record<string, PriceQuote> = {};

  for (const { input, yahoo } of mapping) {
    const q = byYahoo.get(yahoo.toUpperCase());
    quotes[input] = { price: q?.price ?? null, currency: q?.currency ?? null };
  }
  for (const [sym, q] of commodityResults) {
    quotes[sym] = q;
  }

  const usdKrw = byYahoo.get("KRW=X")?.price ?? null;
  const eurKrw = byYahoo.get("EURKRW=X")?.price ?? null;

  return { quotes, usdKrw, eurKrw };
}
