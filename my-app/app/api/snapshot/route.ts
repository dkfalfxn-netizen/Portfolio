import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { fetchPrices } from "@/lib/market-prices";

type Position = {
  symbol: string;
  quantity: number;
  currentPrice: number;
  currency: "USD" | "EUR" | "KRW";
  owner: string;
};
type CashEntry = { usd: number; krw: number };

const FALLBACK_USD_KRW = 1400;
const FALLBACK_EUR_KRW = 1500;

/** 포트폴리오 스냅샷 하나에 대해 시세를 받아서 owner별 평가액을 계산 */
async function calcOwnerValues(
  positions: Position[],
  cashByOwner: Record<string, CashEntry>,
): Promise<{ ownerValues: Record<string, number>; totalValue: number; usdKrw: number }> {
  const symbols = [...new Set(positions.map((p) => p.symbol))];
  const { quotes, usdKrw: fetchedUsd, eurKrw: fetchedEur } = await fetchPrices(symbols);

  const usdKrw = fetchedUsd ?? FALLBACK_USD_KRW;
  const eurKrw = fetchedEur ?? FALLBACK_EUR_KRW;

  const ownerValues: Record<string, number> = {};
  const owners = [...new Set(positions.map((p) => p.owner))];

  for (const owner of owners) {
    const ownerPos = positions.filter((p) => p.owner === owner);
    const cash = cashByOwner[owner] ?? { usd: 0, krw: 0 };

    const stockValue = ownerPos.reduce((sum, p) => {
      // 최신 시세 우선, 없으면 currentPrice(저장된 값) 사용
      const quote = quotes[p.symbol];
      const price = quote?.price ?? p.currentPrice;
      if (p.currency === "USD") return sum + p.quantity * price * usdKrw;
      if (p.currency === "EUR") return sum + p.quantity * price * eurKrw;
      return sum + p.quantity * price;
    }, 0);

    const cashKrw = cash.krw + (cash.usd ?? 0) * usdKrw;
    ownerValues[owner] = stockValue + cashKrw;
  }

  const totalValue = Object.values(ownerValues).reduce((s, v) => s + v, 0);
  return { ownerValues, totalValue, usdKrw };
}

function todayKST(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * GET /api/snapshot?sync_key=XXX&days=90
 * 특정 sync_key의 서버 스냅샷을 반환합니다 (클라이언트가 로컬 스냅샷과 병합)
 */
export async function GET(req: NextRequest) {
  const syncKey = req.nextUrl.searchParams.get("sync_key") ?? "";
  const days = parseInt(req.nextUrl.searchParams.get("days") ?? "180", 10);

  if (!syncKey || syncKey.length < 8) {
    return NextResponse.json({ error: "sync_key가 필요합니다." }, { status: 400 });
  }

  const admin = createSupabaseAdmin();
  if (!admin) {
    return NextResponse.json({ error: "Supabase가 설정되지 않았습니다." }, { status: 503 });
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  const { data, error } = await admin
    .from("portfolio_daily_snapshots")
    .select("date, owner_values, total_value, usd_krw")
    .eq("sync_key", syncKey)
    .gte("date", cutoffDate)
    .order("date", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const snapshots = (data ?? []).map((row) => ({
    date: String(row.date),
    ownerValues: (row.owner_values as Record<string, number>) ?? {},
    totalValue: Number(row.total_value ?? 0),
    usdKrw: Number(row.usd_krw ?? 0),
  }));

  return NextResponse.json({ snapshots });
}

/**
 * POST /api/snapshot
 *
 * 두 가지 모드를 지원합니다.
 *
 * 1) 클라이언트 직접 저장 (권장):
 *    { sync_key, date, ownerValues, totalValue }
 *    → 클라이언트가 계산한 값을 그대로 저장합니다 (시세 재조회 없음, 빠름).
 *    → 이미 해당 날짜 데이터가 있으면 upsert(덮어쓰기)합니다.
 *
 * 2) 서버 재계산 저장 (기존 방식):
 *    { sync_key }
 *    → 서버에 저장된 포지션·현금 데이터로 오늘 시세를 재조회해서 저장합니다.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "JSON 파싱 실패" }, { status: 400 });
  }

  const b = body as {
    sync_key?: unknown;
    date?: unknown;
    ownerValues?: unknown;
    totalValue?: unknown;
  };

  const syncKey = typeof b.sync_key === "string" ? b.sync_key : null;
  if (!syncKey || syncKey.length < 8) {
    return NextResponse.json({ error: "sync_key가 필요합니다." }, { status: 400 });
  }

  const admin = createSupabaseAdmin();
  if (!admin) {
    return NextResponse.json({ error: "Supabase가 설정되지 않았습니다." }, { status: 503 });
  }

  // ── 모드 1: 클라이언트가 값을 직접 제공 ──────────────────────────────────
  const clientDate =
    typeof b.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : null;
  const clientOwnerValues =
    b.ownerValues && typeof b.ownerValues === "object" && !Array.isArray(b.ownerValues)
      ? (b.ownerValues as Record<string, number>)
      : null;
  const clientTotalValue =
    typeof b.totalValue === "number" && Number.isFinite(b.totalValue) ? b.totalValue : null;

  if (clientDate && clientOwnerValues && clientTotalValue !== null) {
    const { error: upsertError } = await admin
      .from("portfolio_daily_snapshots")
      .upsert({
        sync_key: syncKey,
        date: clientDate,
        owner_values: clientOwnerValues,
        total_value: clientTotalValue,
      });

    if (upsertError) {
      return NextResponse.json({ error: upsertError.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, date: clientDate, ownerValues: clientOwnerValues, totalValue: clientTotalValue });
  }

  // ── 모드 2: 서버에서 포지션 조회 후 시세 재계산 ─────────────────────────
  const { data: snap } = await admin
    .from("portfolio_snapshots")
    .select("positions, cash_by_owner")
    .eq("sync_key", syncKey)
    .maybeSingle();

  if (!snap) {
    return NextResponse.json({ error: "포트폴리오 데이터가 없습니다." }, { status: 404 });
  }

  const positions = Array.isArray(snap.positions) ? (snap.positions as Position[]) : [];
  const cashByOwner = ((snap.cash_by_owner as Record<string, CashEntry>) ?? {});
  const { ownerValues, totalValue, usdKrw } = await calcOwnerValues(positions, cashByOwner);

  const today = todayKST();
  const { error: upsertError } = await admin
    .from("portfolio_daily_snapshots")
    .upsert({ sync_key: syncKey, date: today, owner_values: ownerValues, total_value: totalValue, usd_krw: usdKrw });

  if (upsertError) {
    return NextResponse.json({ error: upsertError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, date: today, ownerValues, totalValue });
}

/**
 * 크론 또는 외부 호출: 모든 sync_key에 대해 오늘 스냅샷 저장
 * (alert/check 크론이 내부적으로 호출합니다)
 */
export async function saveAllSnapshots(): Promise<void> {
  const admin = createSupabaseAdmin();
  if (!admin) return;

  const { data: snaps } = await admin
    .from("portfolio_snapshots")
    .select("sync_key, positions, cash_by_owner");

  if (!snaps || snaps.length === 0) return;

  const today = todayKST();

  await Promise.all(
    snaps.map(async (snap) => {
      try {
        const positions = Array.isArray(snap.positions) ? (snap.positions as Position[]) : [];
        const cashByOwner = ((snap.cash_by_owner as Record<string, CashEntry>) ?? {});
        const { ownerValues, totalValue, usdKrw } = await calcOwnerValues(positions, cashByOwner);

        await admin.from("portfolio_daily_snapshots").upsert({
          sync_key: snap.sync_key,
          date: today,
          owner_values: ownerValues,
          total_value: totalValue,
          usd_krw: usdKrw,
        });
      } catch {
        // 개별 실패는 전체 크론을 막지 않음
      }
    }),
  );
}
