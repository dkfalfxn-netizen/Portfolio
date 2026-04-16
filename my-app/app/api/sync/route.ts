import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

const MIN_KEY_LEN = 8;

/** supabase-js가 네트워크 실패 시 영문 기술 메시지를 주는 경우 한국어 안내로 바꿉니다 */
function friendlyDbError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("fetch failed") || m.includes("econnrefused") || m.includes("enotfound") || m.includes("getaddrinfo")) {
    return "Supabase에 연결하지 못했습니다. Vercel의 NEXT_PUBLIC_SUPABASE_URL이 대시보드 Project URL과 한 글자도 같게 맞는지, 프로젝트가 일시 중지(Paused) 상태가 아닌지 확인하세요.";
  }
  return message;
}

function isNetworkLayerError(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("fetch failed") || m.includes("econnrefused") || m.includes("enotfound") || m.includes("getaddrinfo");
}

/** 배포 후 브라우저에서 GET /api/sync 로 Supabase·테이블 연결 여부 확인 */
export async function GET() {
  const admin = createSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      {
        ok: false,
        supabaseConfigured: false,
        hint: "Vercel 환경 변수 NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY를 확인한 뒤 다시 배포하세요. 값 앞뒤 공백·줄바꿈이 없어야 합니다.",
      },
      { status: 503 },
    );
  }
  const { error } = await admin.from("portfolio_snapshots").select("sync_key").limit(1);
  if (error) {
    const network = isNetworkLayerError(error.message);
    return NextResponse.json(
      {
        ok: false,
        supabaseConfigured: true,
        tableError: friendlyDbError(error.message),
        hint: network
          ? "URL/프로젝트 상태를 먼저 확인하세요. fetch failed는 보통 테이블이 없어서가 아니라 Supabase 주소에 연결 자체가 안 될 때 납니다."
          : "Supabase SQL 편집기에서 supabase/portfolio_snapshots.sql을 실행해 테이블을 만드세요.",
      },
      { status: 500 },
    );
  }
  return NextResponse.json({
    ok: true,
    supabaseConfigured: true,
    tableReachable: true,
  });
}

const HOLDINGS_SORT_MODES = new Set(["manual", "valueAsc", "valueDesc", "group"]);

/** 클라이언트와 동일한 키만 허용해 jsonb에 저장 */
function parseHoldingsSortFromJson(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" && HOLDINGS_SORT_MODES.has(v)) {
      out[name] = v;
    }
  }
  return out;
}

type PushBody = {
  action: "push";
  key: string;
  positions: unknown;
  cashByOwner: unknown;
  holdingsSortByOwner?: unknown;
  ownerNames?: unknown;
};

function parseOwnerNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const name = item.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function inferOwnerNamesFromSnapshot(row: {
  owner_names?: unknown;
  positions?: unknown;
  cash_by_owner?: unknown;
  holdings_sort_by_owner?: unknown;
}): string[] {
  const explicit = parseOwnerNames(row.owner_names);
  if (explicit.length > 0) {
    return explicit;
  }
  const fromPositions = Array.isArray(row.positions)
    ? row.positions
        .map((p) => (p && typeof p === "object" ? (p as { owner?: unknown }).owner : undefined))
        .filter((name): name is string => typeof name === "string")
    : [];
  const fromCash =
    row.cash_by_owner && typeof row.cash_by_owner === "object"
      ? Object.keys(row.cash_by_owner as Record<string, unknown>)
      : [];
  const fromSort =
    row.holdings_sort_by_owner && typeof row.holdings_sort_by_owner === "object"
      ? Object.keys(row.holdings_sort_by_owner as Record<string, unknown>)
      : [];
  return parseOwnerNames([...fromPositions, ...fromCash, ...fromSort]);
}

function sanitizePositionsForOwners(positions: unknown, allowed: Set<string>): unknown[] {
  if (!Array.isArray(positions)) return [];
  return positions.filter((p) => {
    if (!p || typeof p !== "object") return false;
    const owner = (p as { owner?: unknown }).owner;
    return typeof owner === "string" && allowed.has(owner);
  });
}

function sanitizeCashForOwners(
  cash: unknown,
  allowed: Set<string>,
): Record<string, unknown> {
  if (!cash || typeof cash !== "object") return {};
  const obj = cash as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const name of allowed) {
    if (Object.prototype.hasOwnProperty.call(obj, name)) {
      out[name] = obj[name];
    }
  }
  return out;
}

function sanitizeHoldingsSortForOwners(
  sort: Record<string, string>,
  allowed: Set<string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(sort)) {
    if (allowed.has(k)) out[k] = v;
  }
  return out;
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON 파싱 실패" }, { status: 400 });
  }

  const admin = createSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      {
        error:
          "서버에 Supabase가 설정되지 않았습니다. NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY를 확인하세요.",
      },
      { status: 503 },
    );
  }

  const action = (body as { action?: string }).action;
  const key = typeof (body as { key?: unknown }).key === "string" ? (body as { key: string }).key : "";

  if (!key || key.length < MIN_KEY_LEN) {
    return NextResponse.json(
      { error: `동기화 키는 ${MIN_KEY_LEN}자 이상이어야 합니다.` },
      { status: 400 },
    );
  }

  if (action === "pull") {
    const withOwnerNames = await admin
      .from("portfolio_snapshots")
      .select("positions, cash_by_owner, holdings_sort_by_owner, owner_names, updated_at")
      .eq("sync_key", key)
      .maybeSingle();
    const fallback = withOwnerNames.error
      ? await admin
          .from("portfolio_snapshots")
          .select("positions, cash_by_owner, holdings_sort_by_owner, updated_at")
          .eq("sync_key", key)
          .maybeSingle()
      : null;
    const data = (withOwnerNames.data ??
      fallback?.data) as
      | {
          positions?: unknown;
          cash_by_owner?: unknown;
          holdings_sort_by_owner?: unknown;
          owner_names?: unknown;
          updated_at?: string | null;
        }
      | null;
    const error = fallback?.error ?? withOwnerNames.error;

    if (error) {
      return NextResponse.json({ error: friendlyDbError(error.message) }, { status: 500 });
    }
    if (!data) {
      return NextResponse.json({
        found: false,
        positions: [],
        cash_by_owner: {},
        holdings_sort_by_owner: {},
        owner_names: [],
        updated_at: null,
      });
    }
    return NextResponse.json({
      found: true,
      positions: data.positions ?? [],
      cash_by_owner: data.cash_by_owner ?? {},
      holdings_sort_by_owner: data.holdings_sort_by_owner ?? {},
      owner_names: inferOwnerNamesFromSnapshot(data),
      updated_at: data.updated_at,
    });
  }

  if (action === "push") {
    const b = body as PushBody;
    if (!Array.isArray(b.positions) || b.cashByOwner === null || typeof b.cashByOwner !== "object") {
      return NextResponse.json({ error: "positions·cashByOwner 형식이 올바르지 않습니다." }, { status: 400 });
    }

    let holdingsSort: Record<string, string>;
    if ("holdingsSortByOwner" in b && b.holdingsSortByOwner != null && typeof b.holdingsSortByOwner === "object") {
      holdingsSort = parseHoldingsSortFromJson(b.holdingsSortByOwner);
    } else {
      const { data: existing } = await admin
        .from("portfolio_snapshots")
        .select("holdings_sort_by_owner")
        .eq("sync_key", key)
        .maybeSingle();
      holdingsSort = parseHoldingsSortFromJson(existing?.holdings_sort_by_owner ?? {});
    }
    let ownerNames: string[];
    if ("ownerNames" in b) {
      ownerNames = parseOwnerNames(b.ownerNames);
    } else {
      const inferred = [
        ...Object.keys((b.cashByOwner as Record<string, unknown>) ?? {}),
        ...(
          Array.isArray(b.positions)
            ? b.positions
                .map((p) => (p && typeof p === "object" ? (p as { owner?: unknown }).owner : undefined))
                .filter((name): name is string => typeof name === "string")
            : []
        ),
      ];
      ownerNames = parseOwnerNames(inferred);
    }
    if (ownerNames.length === 0) {
      ownerNames = parseOwnerNames([
        ...Object.keys((b.cashByOwner as Record<string, unknown>) ?? {}),
        ...(
          Array.isArray(b.positions)
            ? b.positions
                .map((p) => (p && typeof p === "object" ? (p as { owner?: unknown }).owner : undefined))
                .filter((name): name is string => typeof name === "string")
            : []
        ),
      ]);
    }

    const allowed = new Set(ownerNames);
    const positionsOut = sanitizePositionsForOwners(b.positions, allowed);
    const cashOut = sanitizeCashForOwners(b.cashByOwner, allowed);
    const holdingsSortOut = sanitizeHoldingsSortForOwners(holdingsSort, allowed);

    const updatedAt = new Date().toISOString();
    const payload = {
      sync_key: key,
      positions: positionsOut,
      cash_by_owner: cashOut,
      holdings_sort_by_owner: holdingsSortOut,
      owner_names: ownerNames,
      updated_at: updatedAt,
    };
    const withOwnerNames = await admin
      .from("portfolio_snapshots")
      .upsert(payload, { onConflict: "sync_key" });
    const error = withOwnerNames.error
      ? (
          await admin
            .from("portfolio_snapshots")
            .upsert(
              {
                sync_key: key,
                positions: positionsOut,
                cash_by_owner: cashOut,
                holdings_sort_by_owner: holdingsSortOut,
                updated_at: updatedAt,
              },
              { onConflict: "sync_key" },
            )
        ).error
      : null;

    if (error) {
      return NextResponse.json({ error: friendlyDbError(error.message) }, { status: 500 });
    }
    return NextResponse.json({ ok: true, updated_at: updatedAt });
  }

  return NextResponse.json({ error: "action은 pull 또는 push 여야 합니다." }, { status: 400 });
}
