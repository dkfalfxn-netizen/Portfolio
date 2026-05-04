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
  // 한국 6자리 코드: 숫자 6자리 또는 거래소 알파벳 접두사(A/Q 등) + 숫자 6자리
  if (/^[0-9]{6}$/.test(normalized)) return `${normalized}.KS`;
  if (/^[A-Z][0-9]{6}$/.test(normalized)) return `${normalized.slice(1)}.KS`;
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
      signal: AbortSignal.timeout(8000),
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
      signal: AbortSignal.timeout(8000),
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
 * 네이버 증권 모바일 API — 6자리 한국 주식/ETF 코드
 * closePrice(현재가), compareToPreviousClosePrice(전일 대비) 반환
 */
async function fetchNaverStockPrice(code: string): Promise<PriceQuote> {
  try {
    // A458730 등 거래소 접두사가 붙은 경우 제거 (네이버 API는 순수 숫자 코드 사용)
    const cleanCode = /^[A-Z][0-9]{6}$/i.test(code.trim()) ? code.trim().slice(1) : code.trim();
    const url = `https://m.stock.naver.com/api/stock/${encodeURIComponent(cleanCode)}/basic`;
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { price: null, currency: null };
    const d = await res.json() as Record<string, unknown>;
    const price =
      typeof d.closePrice === "string"
        ? parseFloat((d.closePrice as string).replace(/,/g, ""))
        : null;
    if (!price || !Number.isFinite(price) || price <= 0) return { price: null, currency: null };
    return { price, currency: "KRW" };
  } catch {
    return { price: null, currency: null };
  }
}

/**
 * 심볼 배열에 대해 현재가를 일괄 조회합니다.
 * - 한국 6자리 코드(ETF/주식): 네이버 증권 우선, 실패 시 Yahoo Finance 폴백
 * - 금현물 등 KRX 상품: 네이버 금융
 * - 해외/기타: Yahoo Finance
 * USD/KRW, EUR/KRW 환율도 함께 반환합니다.
 */
export async function fetchPrices(inputSymbols: string[]): Promise<PricesResult> {
  const unique = [...new Set(inputSymbols.map((s) => s.trim()).filter(Boolean))];
  const commodities = unique.filter(isKrxCommodity);
  const nonCommodities = unique.filter((s) => !isKrxCommodity(s));

  // 한국 주식/ETF 코드: 숫자 6자리 또는 거래소 알파벳 접두사(A/Q 등) + 숫자 6자리
  const krSixDigit = nonCommodities.filter((s) => /^[0-9]{6}$|^[A-Z][0-9]{6}$/i.test(s.trim()));
  const nonKr = nonCommodities.filter((s) => !/^[0-9]{6}$|^[A-Z][0-9]{6}$/i.test(s.trim()));

  const mapping = nonKr.map((s) => ({ input: s, yahoo: toYahooSymbol(s) }));
  const yahooSet = [...new Set([...mapping.map((m) => m.yahoo), "KRW=X", "EURKRW=X"])];

  const [yahooResults, naverStockResults, commodityResults] = await Promise.all([
    // 해외주식 + 환율
    Promise.all(yahooSet.map(async (sym) => [sym.toUpperCase(), await fetchYahooPrice(sym)] as const)),
    // 한국 주식/ETF — 네이버 우선
    Promise.all(krSixDigit.map(async (sym) => [sym, await fetchNaverStockPrice(sym)] as const)),
    // 금현물 등 KRX 상품
    Promise.all(commodities.map(async (sym) => {
      const q = /^M040200/i.test(sym) ? await fetchNaverGoldPrice() : { price: null, currency: null };
      return [sym, q] as const;
    })),
  ]);

  const byYahoo = new Map<string, PriceQuote>(yahooResults);
  const byNaverStock = new Map<string, PriceQuote>(naverStockResults);
  const quotes: Record<string, PriceQuote> = {};

  // 해외주식
  for (const { input, yahoo } of mapping) {
    const q = byYahoo.get(yahoo.toUpperCase());
    quotes[input] = { price: q?.price ?? null, currency: q?.currency ?? null };
  }

  // 한국 6자리 코드: 네이버 성공 시 사용, 실패 시 Yahoo 폴백
  for (const sym of krSixDigit) {
    const naverQ = byNaverStock.get(sym);
    if (naverQ?.price) {
      quotes[sym] = naverQ;
    } else {
      // Yahoo 폴백 (.KS 변환)
      const yahooSym = toYahooSymbol(sym).toUpperCase();
      const yahooQ = byYahoo.get(yahooSym) ?? await fetchYahooPrice(toYahooSymbol(sym));
      quotes[sym] = { price: yahooQ?.price ?? null, currency: yahooQ?.currency ?? "KRW" };
    }
  }

  // 금현물 등 KRX 상품
  for (const [sym, q] of commodityResults) {
    quotes[sym] = q;
  }

  const usdKrw = byYahoo.get("KRW=X")?.price ?? null;
  const eurKrw = byYahoo.get("EURKRW=X")?.price ?? null;

  return { quotes, usdKrw, eurKrw };
}
