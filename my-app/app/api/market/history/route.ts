import { NextRequest, NextResponse } from "next/server";
import { isKrxCommodity, toYahooSymbol } from "@/lib/market-prices";

type DailyPrice = {
  date: string;
  close: number;
  high: number;
  low: number;
  volume: number;
};

function parseSeries(data: unknown): DailyPrice[] {
  const r0 = (data as { chart?: { result?: unknown[] } })?.chart?.result?.[0] as
    | {
        timestamp?: unknown[];
        indicators?: { quote?: Array<{ close?: unknown[]; high?: unknown[]; low?: unknown[]; volume?: unknown[] }> };
      }
    | undefined;
  if (!r0?.timestamp || !Array.isArray(r0.timestamp)) return [];

  const q = r0.indicators?.quote?.[0];
  const close = Array.isArray(q?.close) ? q.close : [];
  const high = Array.isArray(q?.high) ? q.high : [];
  const low = Array.isArray(q?.low) ? q.low : [];
  const volume = Array.isArray(q?.volume) ? q.volume : [];

  const out: DailyPrice[] = [];
  for (let i = 0; i < r0.timestamp.length; i++) {
    const ts = r0.timestamp[i];
    const c = close[i];
    const h = high[i];
    const l = low[i];
    const v = volume[i];
    if (typeof ts !== "number" || typeof c !== "number" || typeof h !== "number" || typeof l !== "number") {
      continue;
    }
    if (!Number.isFinite(c) || !Number.isFinite(h) || !Number.isFinite(l) || c <= 0 || h <= 0 || l <= 0) {
      continue;
    }
    const d = new Date(ts * 1000);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    out.push({
      date: `${y}-${m}-${day}`,
      close: c,
      high: h,
      low: l,
      volume: typeof v === "number" && Number.isFinite(v) ? v : 0,
    });
  }
  return out;
}

export async function GET(req: NextRequest) {
  const symbolsParam = req.nextUrl.searchParams.get("symbols") ?? "";
  const symbols = [...new Set(symbolsParam.split(",").map((s) => s.trim()).filter(Boolean))];
  if (symbols.length === 0) return NextResponse.json({ history: {} });

  const entries = await Promise.all(
    symbols.map(async (symbol) => {
      if (isKrxCommodity(symbol)) return [symbol, []] as const;
      const yahoo = toYahooSymbol(symbol);
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahoo)}?interval=1d&range=6mo`;
        const res = await fetch(url, {
          method: "GET",
          cache: "no-store",
          headers: { "User-Agent": "Mozilla/5.0" },
        });
        if (!res.ok) return [symbol, []] as const;
        const data = await res.json();
        return [symbol, parseSeries(data)] as const;
      } catch {
        return [symbol, []] as const;
      }
    }),
  );

  return NextResponse.json({
    history: Object.fromEntries(entries),
    fetchedAt: Date.now(),
  });
}

