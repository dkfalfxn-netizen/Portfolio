import { NextRequest, NextResponse } from "next/server";

/** 시세(Yahoo)가 보고한 최근 분할 이벤트 — 알려진 분할이 실제 시세에 반영됐는지 확인하는 용도 */
export type StockSplitEvent = {
  symbol: string;
  /** 분할 반영 가격으로 첫 거래된 날(미국 동부시간 기준 YYYY-MM-DD) */
  date: string;
  numerator: number;
  denominator: number;
  /** numerator / denominator (3:1 → 3, 1:10 → 0.1) */
  factor: number;
};

export type StockSplitsResponse = {
  splits: StockSplitEvent[];
  fetchedAt: number;
  /** 조회 실패한 심볼(진단용) */
  failed?: string[];
};

const YAHOO_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map<string, { at: number; splits: StockSplitEvent[] }>();

function etDate(unixSec: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(unixSec * 1000));
}

async function fetchSplits(symbol: string): Promise<StockSplitEvent[] | null> {
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.splits;
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      symbol,
    )}?interval=1d&range=3mo&events=split`;
    const res = await fetch(url, { method: "GET", cache: "no-store", headers: { "User-Agent": YAHOO_UA } });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      chart?: {
        result?: Array<{
          events?: {
            splits?: Record<string, { date?: number; numerator?: number; denominator?: number }>;
          };
        }>;
      };
    };
    const raw = data.chart?.result?.[0]?.events?.splits ?? {};
    const splits: StockSplitEvent[] = [];
    for (const [k, v] of Object.entries(raw)) {
      const ts = typeof v.date === "number" ? v.date : Number(k);
      const num = Number(v.numerator);
      const den = Number(v.denominator);
      if (!Number.isFinite(ts) || !(num > 0) || !(den > 0)) continue;
      splits.push({ symbol, date: etDate(ts), numerator: num, denominator: den, factor: num / den });
    }
    cache.set(symbol, { at: Date.now(), splits });
    return splits;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const symbols = [
    ...new Set(
      (req.nextUrl.searchParams.get("symbols") ?? "")
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter((s) => /^[A-Z0-9.\-]{1,12}$/.test(s)),
    ),
  ].slice(0, 20);
  if (symbols.length === 0) {
    return NextResponse.json({ error: "symbols 파라미터가 필요합니다" }, { status: 400 });
  }
  const results = await Promise.all(symbols.map(async (s) => [s, await fetchSplits(s)] as const));
  const splits = results.flatMap(([, r]) => r ?? []);
  const failed = results.filter(([, r]) => r === null).map(([s]) => s);
  return NextResponse.json({ splits, fetchedAt: Date.now(), ...(failed.length ? { failed } : {}) } satisfies StockSplitsResponse);
}
