import { NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

type Row = {
  report_date: string;
  net_liquidity: number | null;
  net_liquidity_pct: number | null;
  dxy: number | null;
  us10y: number | null;
  hy_spread: number | null;
  vix: number | null;
  btc: number | null;
  gold: number | null;
  ai_summary: string | null;
};

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export async function GET() {
  const admin = createSupabaseAdmin();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "Supabase 설정 누락" }, { status: 503 });
  }

  const { data, error } = await admin
    .from("liquidity_briefings")
    .select("report_date, net_liquidity, net_liquidity_pct, dxy, us10y, hy_spread, vix, btc, gold, ai_summary")
    .order("report_date", { ascending: true })
    .limit(120);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as Row[];
  return NextResponse.json({
    ok: true,
    rows: rows.map((r) => ({
      date: r.report_date,
      netLiquidity: toNum(r.net_liquidity),
      netLiquidityPct: toNum(r.net_liquidity_pct),
      dxy: toNum(r.dxy),
      us10y: toNum(r.us10y),
      hySpread: toNum(r.hy_spread),
      vix: toNum(r.vix),
      btc: toNum(r.btc),
      gold: toNum(r.gold),
      aiSummary: r.ai_summary ?? "",
    })),
  });
}
