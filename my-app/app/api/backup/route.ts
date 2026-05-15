import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import {
  emptyPortfolioBackupSnapshot,
  normalizePortfolioBackupSnapshot,
  type PortfolioBackupSnapshot,
} from "@/lib/portfolio-backup-snapshot";

const MIN_KEY_LEN = 8;
/** 백업 보관 기간(일). 이보다 오래된 행은 새 백업 저장 시 삭제합니다. */
const RETENTION_DAYS = 365;

const SELECT_FULL =
  "positions, cash_by_owner, holdings_sort_by_owner, owner_names, sell_log_by_owner, target_stock_weight_by_owner, owner_scratchpad_by_owner, rebalance_calculator_by_owner, alert_thresholds_by_position, updated_at";

const SELECT_NO_ALERT =
  "positions, cash_by_owner, holdings_sort_by_owner, owner_names, sell_log_by_owner, target_stock_weight_by_owner, owner_scratchpad_by_owner, rebalance_calculator_by_owner, updated_at";

const SELECT_NO_REBALANCE =
  "positions, cash_by_owner, holdings_sort_by_owner, owner_names, sell_log_by_owner, target_stock_weight_by_owner, owner_scratchpad_by_owner, updated_at";

const SELECT_MINIMAL =
  "positions, cash_by_owner, holdings_sort_by_owner, owner_names, updated_at";

function isMissingColumnError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    (m.includes("column") && (m.includes("does not exist") || m.includes("unknown"))) ||
    m.includes("schema cache")
  );
}

async function fetchServerSnapshotRow(
  admin: ReturnType<typeof createSupabaseAdmin>,
  key: string,
): Promise<{ row: Record<string, unknown> | null; error: string | null }> {
  if (!admin) return { row: null, error: "no admin" };

  const attempts = [SELECT_FULL, SELECT_NO_ALERT, SELECT_NO_REBALANCE, SELECT_MINIMAL];
  let lastErr: string | null = null;
  for (const sel of attempts) {
    const { data, error } = await admin
      .from("portfolio_snapshots")
      .select(sel)
      .eq("sync_key", key)
      .maybeSingle();
    if (!error) {
      return { row: (data as Record<string, unknown> | null) ?? null, error: null };
    }
    lastErr = error.message;
    if (!isMissingColumnError(error.message)) {
      return { row: null, error: error.message };
    }
  }
  return { row: null, error: lastErr };
}

function rowToBackupSnapshot(row: Record<string, unknown>): PortfolioBackupSnapshot {
  const base = normalizePortfolioBackupSnapshot(row) ?? emptyPortfolioBackupSnapshot();
  return {
    ...base,
    source_updated_at:
      typeof row.updated_at === "string" ? row.updated_at : base.source_updated_at,
  };
}

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

  const clientSnapshotRaw = (body as { snapshot?: unknown }).snapshot;
  const clientSnapshot =
    clientSnapshotRaw !== undefined
      ? normalizePortfolioBackupSnapshot(clientSnapshotRaw)
      : null;
  if (clientSnapshotRaw !== undefined && !clientSnapshot) {
    return NextResponse.json({ error: "백업 snapshot 형식이 올바르지 않습니다." }, { status: 400 });
  }

  let snapshot: PortfolioBackupSnapshot;
  let fromClient = false;

  if (clientSnapshot) {
    snapshot = {
      ...clientSnapshot,
      source_updated_at: clientSnapshot.source_updated_at ?? new Date().toISOString(),
    };
    fromClient = true;
  } else {
    const { row, error: fetchErr } = await fetchServerSnapshotRow(admin, key);
    if (fetchErr) {
      return NextResponse.json({ error: fetchErr }, { status: 500 });
    }
    if (!row) {
      return NextResponse.json(
        { error: "서버에 해당 키의 데이터가 없습니다. 먼저 이 기기에서 동기화해 주세요." },
        { status: 404 },
      );
    }
    snapshot = rowToBackupSnapshot(row);
  }

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

  const baseMessage = fromClient
    ? "이 기기의 잔고·기준선·목표비중·메모 등 수기 입력을 포함해 백업했습니다."
    : `서버에 백업을 저장했습니다.`;

  if (delErr) {
    return NextResponse.json(
      {
        ok: true,
        warning: "백업은 저장되었으나 오래된 백업 정리에 실패했습니다.",
        detail: delErr.message,
        message: baseMessage,
      },
      { status: 200 },
    );
  }

  return NextResponse.json({
    ok: true,
    message: `${baseMessage} 이 키의 백업은 ${RETENTION_DAYS}일간 보관됩니다.`,
  });
}
