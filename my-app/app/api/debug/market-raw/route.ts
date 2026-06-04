import { NextRequest, NextResponse } from "next/server";

/** 디버그용: Yahoo Finance raw meta 확인 — 배포 후 /api/debug/market-raw?symbol=AAPL 로 접근 */
export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol") ?? "AAPL";
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`;
  const res = await fetch(url, {
    cache: "no-store",
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) return NextResponse.json({ error: res.status }, { status: 500 });
  const data = await res.json();
  const meta = data?.chart?.result?.[0]?.meta ?? null;
  const keys = [
    "marketState",
    "regularMarketPrice",
    "regularMarketTime",
    "postMarketPrice",
    "postMarketTime",
    "preMarketPrice",
    "preMarketTime",
    "chartPreviousClose",
    "previousClose",
    "currency",
  ];
  const picked = keys.reduce<Record<string, unknown>>((acc, k) => {
    acc[k] = meta?.[k] ?? null;
    return acc;
  }, {});
  return NextResponse.json({ symbol, picked, fetchedAt: new Date().toISOString() });
}
