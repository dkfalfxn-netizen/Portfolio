import { NextRequest, NextResponse } from "next/server";

function normalizeKrxCode(raw: string): string | null {
  const s = raw.trim().toUpperCase();
  if (!s) return null;
  if (s.startsWith("KRX:")) {
    const code = s.slice(4);
    return /^[0-9][0-9A-Z]{5}$/.test(code) ? code : null;
  }
  if (s.startsWith("KQ:")) {
    const code = s.slice(3);
    return /^[0-9][0-9A-Z]{5}$/.test(code) ? code : null;
  }
  return /^[0-9][0-9A-Z]{5}$/.test(s) ? s : null;
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
      const code = normalizeKrxCode(sym);
      if (!code) return;
      const name = await fetchNaverName(code);
      if (name) names[sym] = name;
    }),
  );

  return NextResponse.json({ names });
}

