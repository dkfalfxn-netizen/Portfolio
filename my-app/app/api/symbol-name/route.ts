import { NextRequest, NextResponse } from "next/server";
import { toYahooSymbol } from "@/lib/finance-symbols";

/** 네이버 모바일 API용 종목 코드 (예: A458730 → 숫자 6자리) */
function resolveNaverStockCode(raw: string): string | null {
  const s = raw.trim().toUpperCase();
  if (!s) return null;
  let core = s;
  if (s.startsWith("KRX:")) core = s.slice(4);
  else if (s.startsWith("KQ:")) core = s.slice(3);
  if (/^[A-Z][0-9]{6}$/.test(core)) return core.slice(1);
  if (/^[0-9][0-9A-Z]{5}$/.test(core)) return core;
  return null;
}

async function fetchNaverName(code: string): Promise<string | null> {
  try {
    const url = `https://m.stock.naver.com/api/stock/${encodeURIComponent(code)}/basic`;
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const d = (await res.json()) as Record<string, unknown>;
    const name = [d.stockName, d.itemName, d.name, d.shortName].find(
      (v): v is string => typeof v === "string" && v.trim().length > 0,
    );
    return name?.trim() ?? null;
  } catch {
    return null;
  }
}

async function fetchYahooLongName(rawInput: string): Promise<string | null> {
  const yahoo = toYahooSymbol(rawInput.trim());
  try {
    const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      yahoo,
    )}?interval=1d&range=5d`;
    const res = await fetch(chartUrl, {
      method: "GET",
      cache: "no-store",
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { chart?: { result?: Array<{ meta?: Record<string, unknown> }> } };
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) return null;
    const longName = meta.longName;
    const shortName = meta.shortName;
    const nm =
      typeof longName === "string" && longName.trim()
        ? longName.trim()
        : typeof shortName === "string" && shortName.trim()
          ? shortName.trim()
          : null;
    return nm;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const symbolsParam = req.nextUrl.searchParams.get("symbols") ?? "";
  const rawSymbols = symbolsParam
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 60);

  const names: Record<string, string> = {};
  if (rawSymbols.length === 0) {
    return NextResponse.json({ names });
  }

  const unique = [...new Set(rawSymbols)];
  await Promise.all(
    unique.map(async (sym) => {
      const naverCode = resolveNaverStockCode(sym);
      if (naverCode) {
        const name = await fetchNaverName(naverCode);
        if (name) {
          names[sym] = name;
          return;
        }
      }
      const yahooName = await fetchYahooLongName(sym);
      if (yahooName) names[sym] = yahooName;
    }),
  );

  return NextResponse.json({ names });
}

