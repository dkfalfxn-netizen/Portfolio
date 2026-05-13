import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

const MIN_KEY_LEN = 8;
/** 백업 보관 기간(일). 이보다 오래된 행은 새 백업 저장 시 삭제합니다. */
const RETENTION_DAYS = 365;

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON 파싱 실패" }, { status: 400 });
  }

  const key =
    typeof (body as { sync_key?: unknown }).sync_key === "string"
      ? (body as { sync_key: string }).sync_key.trim()
      : "";
  if (!key || key.length < MIN_KEY_LEN) {
    return NextResponse.json(
      { error: `동기화 키는 ${MIN_KEY_LEN}자 이상이어야 합니다.` },
      { status: 400 },
    );
  }

  const admin = createSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { error: "서버에 Supabase가 설정되지 않았습니다." },
      { status: 503 },
    );
  }

  const withSellLog = await admin
    .from("portfolio_snapshots")
    .select(
      "positions, cash_by_owner, holdings_sort_by_owner, owner_names, sell_log_by_owner, target_stock_weight_by_owner, owner_scratchpad_by_owner, rebalance_calculator_by_owner, updated_at",
    )
    .eq("sync_key", key)
    .maybeSingle();
  const fallbackNoRebalanceCalc = withSellLog.error
    ? await admin
        .from("portfolio_snapshots")
        .select(
          "positions, cash_by_owner, holdings_sort_by_owner, owner_names, sell_log_by_owner, target_stock_weight_by_owner, owner_scratchpad_by_owner, updated_at",
        )
        .eq("sync_key", key)
        .maybeSingle()
    : null;
  const fallback = fallbackNoRebalanceCalc?.error
    ? await admin
        .from("portfolio_snapshots")
        .select("positions, cash_by_owner, holdings_sort_by_owner, owner_names, updated_at")
        .eq("sync_key", key)
        .maybeSingle()
    : null;
  const row =
    withSellLog.data ??
    fallbackNoRebalanceCalc?.data ??
    fallback?.data ??
    null;
  const snapshotRow = (row ?? null) as
    | {
        positions?: unknown;
        cash_by_owner?: unknown;
        holdings_sort_by_owner?: unknown;
        owner_names?: unknown;
        sell_log_by_owner?: unknown;
        target_stock_weight_by_owner?: unknown;
        owner_scratchpad_by_owner?: unknown;
        rebalance_calculator_by_owner?: unknown;
        updated_at?: string | null;
      }
    | null;

  if (!snapshotRow) {
    const selErr = fallback?.error ?? fallbackNoRebalanceCalc?.error ?? withSellLog.error;
    if (selErr) {
      return NextResponse.json({ error: selErr.message }, { status: 500 });
    }
    return NextResponse.json(
      { error: "서버에 해당 키의 데이터가 없습니다. 먼저 이 기기에서 동기화해 주세요." },
      { status: 404 },
    );
  }

  const snapshot = {
    positions: snapshotRow.positions ?? [],
    cash_by_owner: snapshotRow.cash_by_owner ?? {},
    holdings_sort_by_owner: snapshotRow.holdings_sort_by_owner ?? {},
    owner_names: snapshotRow.owner_names ?? [],
    sell_log_by_owner: snapshotRow.sell_log_by_owner ?? {},
    target_stock_weight_by_owner: snapshotRow.target_stock_weight_by_owner ?? {},
    owner_scratchpad_by_owner: snapshotRow.owner_scratchpad_by_owner ?? {},
    rebalance_calculator_by_owner: snapshotRow.rebalance_calculator_by_owner ?? {},
    source_updated_at: snapshotRow.updated_at ?? null,
  };

  const { error: insErr } = await admin.from("portfolio_snapshot_backups").insert({
    sync_key: key,
    snapshot,
  });

  if (insErr) {
    const hint =
      insErr.message.includes("relation") || insErr.message.includes("schema cache")
        ? " Supabase에서 supabase/portfolio_snapshot_backups.sql을 실행해 테이블을 만드세요."
        : "";
    return NextResponse.json({ error: insErr.message + hint }, { status: 500 });
  }

  const cutoffMs = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  const { error: delErr } = await admin
    .from("portfolio_snapshot_backups")
    .delete()
    .eq("sync_key", key)
    .lt("created_at", cutoffIso);

  if (delErr) {
    return NextResponse.json(
      { ok: true, warning: "백업은 저장되었으나 오래된 백업 정리에 실패했습니다.", detail: delErr.message },
      { status: 200 },
    );
  }

  return NextResponse.json({
    ok: true,
    message: `서버에 백업을 저장했습니다. 이 키의 백업은 ${RETENTION_DAYS}일간 보관됩니다.`,
  });
}
