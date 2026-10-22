import { NextRequest, NextResponse } from "next/server";

export type EtfHoldingQuote = {
  symbol: string;
  name: string;
  /** ETF 내 비중(%) — Yahoo topHoldings 기준, 리밸런싱 시 자동 갱신 */
  weightPct: number | null;
  price: number | null;
  previousClose: number | null;
  changePct: number | null;
};

export type EtfHoldingsResponse = {
  symbol: string;
  /** topHoldings 모듈이 돌려주는 상위 보유 종목 수(보통 10개) */
  holdings: EtfHoldingQuote[];
  fetchedAt: number;
};

/** topHoldings 캐시 — 보유 구성은 하루 수 차례만 바뀌므로 동일 인스턴스 내 재조회 비용을 줄임 */
const topHoldingsCache = new Map<string, { holdings: { symbol: string; name: string; weightPct: number | null }[]; fetchedAt: number }>();
const TOP_HOLDINGS_TTL_MS = 60 * 60 * 1000; // 1시간

const YAHOO_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

/** quoteSummary는 쿠키+crumb 인증이 필요(v8 chart API와 달리). 세션당 캐시해 재사용 */
let yahooAuthCache: { cookie: string; crumb: string; fetchedAt: number } | null = null;
const YAHOO_AUTH_TTL_MS = 50 * 60 * 1000; // 50분

function parseSetCookies(res: Response): string {
  const getSetCookie = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const raw = typeof getSetCookie === "function" ? getSetCookie.call(res.headers) : [res.headers.get("set-cookie") ?? ""];
  return raw
    .filter(Boolean)
    .map((c) => c.split(";")[0])
    .join("; ");
}

async function getYahooAuth(): Promise<{ cookie: string; crumb: string } | null> {
  if (yahooAuthCache && Date.now() - yahooAuthCache.fetchedAt < YAHOO_AUTH_TTL_MS) {
    return yahooAuthCache;
  }
  try {
    const cookieRes = await fetch("https://fc.yahoo.com", {
      method: "GET",
      cache: "no-store",
      headers: { "User-Agent": YAHOO_UA },
      redirect: "manual",
    });
    const cookie = parseSetCookies(cookieRes);
    if (!cookie) return null;

    const crumbRes = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
      method: "GET",
      cache: "no-store",
      headers: { "User-Agent": YAHOO_UA, Cookie: cookie },
    });
    if (!crumbRes.ok) return null;
    const crumb = (await crumbRes.text()).trim();
    if (!crumb) return null;

    yahooAuthCache = { cookie, crumb, fetchedAt: Date.now() };
    return yahooAuthCache;
  } catch {
    return null;
  }
}

async function fetchTopHoldings(
  symbol: string,
): Promise<{ symbol: string; name: string; weightPct: number | null }[]> {
  const cached = topHoldingsCache.get(symbol);
  if (cached && Date.now() - cached.fetchedAt < TOP_HOLDINGS_TTL_MS) {
    return cached.holdings;
  }

  const auth = await getYahooAuth();
  if (!auth) return cached?.holdings ?? [];

  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
    symbol,
  )}?modules=topHoldings&crumb=${encodeURIComponent(auth.crumb)}`;
  let res = await fetch(url, {
    method: "GET",
    cache: "no-store",
    headers: { "User-Agent": YAHOO_UA, Accept: "application/json", Cookie: auth.cookie },
  });
  if (res.status === 401) {
    // 캐시된 crumb/쿠키가 만료됐을 수 있음 — 한 번 재발급 후 재시도
    yahooAuthCache = null;
    const freshAuth = await getYahooAuth();
    if (!freshAuth) return cached?.holdings ?? [];
    res = await fetch(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
        symbol,
      )}?modules=topHoldings&crumb=${encodeURIComponent(freshAuth.crumb)}`,
      {
        method: "GET",
        cache: "no-store",
        headers: { "User-Agent": YAHOO_UA, Accept: "application/json", Cookie: freshAuth.cookie },
      },
    );
  }
  if (!res.ok) return cached?.holdings ?? [];

  const data = (await res.json()) as {
    quoteSummary?: {
      result?: Array<{
        topHoldings?: {
          holdings?: Array<{
            symbol?: string;
            holdingName?: string;
            holdingPercent?: { raw?: number };
          }>;
        };
      }>;
    };
  };

  const raw = data.quoteSummary?.result?.[0]?.topHoldings?.holdings ?? [];
  const holdings = raw
    .map((h) => ({
      symbol: (h.symbol ?? "").trim().toUpperCase(),
      name: (h.holdingName ?? h.symbol ?? "").trim(),
      weightPct:
        typeof h.holdingPercent?.raw === "number" && Number.isFinite(h.holdingPercent.raw)
          ? h.holdingPercent.raw * 100
          : null,
    }))
    .filter((h) => h.symbol.length > 0);

  if (holdings.length > 0) {
    topHoldingsCache.set(symbol, { holdings, fetchedAt: Date.now() });
  }
  return holdings;
}

async function fetchQuote(symbol: string): Promise<{ price: number | null; previousClose: number | null }> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      symbol,
    )}?interval=1d&range=5d`;
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: { "User-Agent": YAHOO_UA },
    });
    if (!res.ok) return { price: null, previousClose: null };
    const data = (await res.json()) as {
      chart?: { result?: Array<{ meta?: Record<string, unknown> }> };
    };
    const meta = data.chart?.result?.[0]?.meta;
    const num = (k: string) => {
      const v = meta?.[k];
      return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
    };
    const price = num("regularMarketPrice");
    const previousClose = num("chartPreviousClose") ?? num("previousClose");
    return { price, previousClose };
  } catch {
    return { price: null, previousClose: null };
  }
}

export async function GET(req: NextRequest) {
  const symbol = (req.nextUrl.searchParams.get("symbol") ?? "").trim().toUpperCase();
  if (!symbol) {
    return NextResponse.json({ error: "symbol 파라미터가 필요합니다" }, { status: 400 });
  }

  try {
    const topHoldings = await fetchTopHoldings(symbol);
    if (topHoldings.length === 0) {
      return NextResponse.json({ symbol, holdings: [], fetchedAt: Date.now() } satisfies EtfHoldingsResponse);
    }

    const quotes = await Promise.all(topHoldings.map((h) => fetchQuote(h.symbol)));

    const holdings: EtfHoldingQuote[] = topHoldings.map((h, i) => {
      const q = quotes[i];
      const changePct =
        q.price !== null && q.previousClose !== null && q.previousClose !== 0
          ? ((q.price - q.previousClose) / q.previousClose) * 100
          : null;
      return {
        symbol: h.symbol,
        name: h.name,
        weightPct: h.weightPct,
        price: q.price,
        previousClose: q.previousClose,
        changePct,
      };
    });

    return NextResponse.json({ symbol, holdings, fetchedAt: Date.now() } satisfies EtfHoldingsResponse);
  } catch {
    return NextResponse.json({ error: "구성 종목 조회 오류" }, { status: 500 });
  }
}
