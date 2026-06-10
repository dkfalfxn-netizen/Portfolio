import { NextRequest, NextResponse } from "next/server";
import { krSettlementTargetUnixSec } from "@/lib/trading-calendar";

const YAHOO_KRW_X = "KRW=X";

function pickClosestClose(
  timestamps: number[],
  closes: (number | null)[],
  targetSec: number,
): { rate: number; barUnixSec: number } | null {
  let bestRate: number | null = null;
  let bestTs = 0;
  let bestDist = Infinity;
  for (let i = 0; i < timestamps.length; i++) {
    const c = closes[i];
    if (c == null || typeof c !== "number" || !Number.isFinite(c) || c <= 0) continue;
    const t = timestamps[i]!;
    const dist = Math.abs(t - targetSec);
    if (dist < bestDist) {
      bestDist = dist;
      bestRate = c;
      bestTs = t;
    }
  }
  if (bestRate === null) return null;
  return { rate: bestRate, barUnixSec: bestTs };
}

async function fetchYahooKrwXNear(targetSec: number, interval: "1h" | "1d"): Promise<{ rate: number; barUnixSec: number } | null> {
  const pad = interval === "1h" ? 72 * 3600 : 21 * 86400;
  const period1 = targetSec - pad;
  const period2 = targetSec + pad;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(YAHOO_KRW_X)}?period1=${period1}&period2=${period2}&interval=${interval}`;
  const res = await fetch(url, {
    method: "GET",
    cache: "no-store",
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ close?: unknown[] }> } }> };
  };
  const result = data?.chart?.result?.[0];
  const ts = result?.timestamp;
  const closesRaw = result?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(ts) || !Array.isArray(closesRaw) || ts.length === 0) return null;
  const closes = closesRaw as (number | null)[];
  return pickClosestClose(ts, closes, targetSec);
}

export async function GET(req: NextRequest) {
  const purchaseDate = req.nextUrl.searchParams.get("purchaseDate") ?? "";
  // 매입일 + 2영업일(주말·공휴일 제외) 09:00 KST 시점
  const sec = krSettlementTargetUnixSec(purchaseDate, 2, 9);
  if (sec === null) {
    return NextResponse.json({ error: "purchaseDate는 YYYY-MM-DD 형식이어야 합니다." }, { status: 400 });
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (sec > nowSec) {
    return NextResponse.json(
      { error: "선택한 매입일 기준 환율 시점이 아직 지나지 않았습니다." },
      { status: 400 },
    );
  }

  try {
    let picked = await fetchYahooKrwXNear(sec, "1h");
    if (!picked) {
      picked = await fetchYahooKrwXNear(sec, "1d");
    }
    if (!picked) {
      return NextResponse.json({ error: "해당 시점 부근의 환율 데이터를 찾지 못했습니다." }, { status: 404 });
    }

    return NextResponse.json({
      rate: picked.rate,
      purchaseDate,
      targetUnixSec: sec,
      barUnixSec: picked.barUnixSec,
      source: "yahoo",
    });
  } catch {
    return NextResponse.json({ error: "환율 조회 중 오류가 발생했습니다." }, { status: 502 });
  }
}
