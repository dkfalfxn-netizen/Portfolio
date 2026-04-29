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
  sellLogByOwner?: unknown;
  targetStockWeightByOwner?: unknown;
};

type SellLogCurrency = "USD" | "EUR" | "KRW";
type SellLogEntry = {
  id: string;
  date: string;
  symbol: string;
  name: string;
  qty: number;
  sellPrice: number;
  avgPrice: number;
  currency: SellLogCurrency;
  fxRate: number;
  realizedKrw: number;
  note?: string;
};

function parseSellLogCurrency(raw: unknown): SellLogCurrency | null {
  return raw === "USD" || raw === "EUR" || raw === "KRW" ? raw : null;
}

function sanitizeSellLogForOwners(
  raw: unknown,
  allowed: Set<string>,
): Record<string, SellLogEntry[]> {
  const out: Record<string, SellLogEntry[]> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [owner, entries] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowed.has(owner) || !Array.isArray(entries)) continue;
    const cleaned: SellLogEntry[] = [];
    for (const item of entries) {
      if (!item || typeof item !== "object") continue;
      const e = item as Record<string, unknown>;
      const currency = parseSellLogCurrency(e.currency);
      const id = typeof e.id === "string" ? e.id.trim() : "";
      const date = typeof e.date === "string" ? e.date.trim() : "";
      const symbol = typeof e.symbol === "string" ? e.symbol.trim() : "";
      const name = typeof e.name === "string" ? e.name.trim() : "";
      const qty = Number(e.qty);
      const sellPrice = Number(e.sellPrice);
      const avgPrice = Number(e.avgPrice);
      const fxRate = Number(e.fxRate);
      const realizedKrw = Number(e.realizedKrw);
      if (!currency || !id || !date || !symbol || !name) continue;
      if (
        !Number.isFinite(qty) ||
        !Number.isFinite(sellPrice) ||
        !Number.isFinite(avgPrice) ||
        !Number.isFinite(fxRate) ||
        !Number.isFinite(realizedKrw)
      ) {
        continue;
      }
      const note = typeof e.note === "string" && e.note.trim() ? e.note.trim() : undefined;
      cleaned.push({
        id,
        date,
        symbol,
        name,
        qty,
        sellPrice,
        avgPrice,
        currency,
        fxRate,
        realizedKrw,
        note,
      });
    }
    out[owner] = cleaned;
  }
  return out;
}

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

function parseCashPairInfer(raw: unknown): { usd: number; krw: number } {
  if (!raw || typeof raw !== "object") return { usd: 0, krw: 0 };
  const o = raw as { usd?: unknown; krw?: unknown };
  const usd = Number(o.usd ?? 0);
  const krw = Number(o.krw ?? 0);
  return {
    usd: Number.isFinite(usd) && usd >= 0 ? usd : 0,
    krw: Number.isFinite(krw) && krw >= 0 ? krw : 0,
  };
}

function inferOwnerNamesFromSnapshot(row: {
  owner_names?: unknown;
  positions?: unknown;
  cash_by_owner?: unknown;
  holdings_sort_by_owner?: unknown;
  sell_log_by_owner?: unknown;
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
  /** 레거시: 잔액 0인 cash 키만으로는 보유자 부활하지 않도록 제외 (정렬 JSON 키도 제외) */
  const fromCash: string[] = [];
  if (row.cash_by_owner && typeof row.cash_by_owner === "object") {
    for (const [name, value] of Object.entries(row.cash_by_owner as Record<string, unknown>)) {
      if (typeof name !== "string" || !name.trim()) continue;
      const { usd, krw } = parseCashPairInfer(value);
      if (usd > 0 || krw > 0) fromCash.push(name);
    }
  }
  const fromSellLog: string[] = [];
  if (row.sell_log_by_owner && typeof row.sell_log_by_owner === "object") {
    for (const [name, entries] of Object.entries(row.sell_log_by_owner as Record<string, unknown>)) {
      if (typeof name !== "string" || !name.trim()) continue;
      if (Array.isArray(entries) && entries.length > 0) fromSellLog.push(name);
    }
  }
  return parseOwnerNames([...fromPositions, ...fromCash, ...fromSellLog]);
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

type TargetMap = Record<string, Record<string, number>>;

function sanitizeTargetStockWeightsForOwners(raw: unknown, allowed: Set<string>): TargetMap {
  const out: TargetMap = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [owner, inner] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof owner !== "string" || !owner.trim() || !allowed.has(owner)) continue;
    if (!inner || typeof inner !== "object" || Array.isArray(inner)) continue;
    const row: Record<string, number> = {};
    for (const [ticker, v] of Object.entries(inner as Record<string, unknown>)) {
      if (typeof ticker !== "string" || !ticker.trim()) continue;
      const n = Number(v);
      if (Number.isFinite(n) && n > 0 && n <= 100) row[ticker] = n;
    }
    if (Object.keys(row).length) out[owner] = row;
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
    const withSellLog = await admin
      .from("portfolio_snapshots")
      .select(
        "positions, cash_by_owner, holdings_sort_by_owner, owner_names, sell_log_by_owner, target_stock_weight_by_owner, updated_at",
      )
      .eq("sync_key", key)
      .maybeSingle();
    const fallback = withSellLog.error
      ? await admin
          .from("portfolio_snapshots")
          .select("positions, cash_by_owner, holdings_sort_by_owner, updated_at")
          .eq("sync_key", key)
          .maybeSingle()
      : null;
    const data = (withSellLog.data ??
      fallback?.data) as
      | {
          positions?: unknown;
          cash_by_owner?: unknown;
          holdings_sort_by_owner?: unknown;
          owner_names?: unknown;
          sell_log_by_owner?: unknown;
          target_stock_weight_by_owner?: unknown;
          updated_at?: string | null;
        }
      | null;
    const error = fallback?.error ?? withSellLog.error;

    if (error) {
      return NextResponse.json({ error: friendlyDbError(error.message) }, { status: 500 });
    }
    if (!data) {
      return NextResponse.json({
        found: false,
        positions: [],
        cash_by_owner: {},
        holdings_sort_by_owner: {},
        sell_log_by_owner: {},
        owner_names: [],
        target_stock_weight_by_owner: {},
        updated_at: null,
      });
    }
    const ownerList = inferOwnerNamesFromSnapshot(data);
    const allowed = new Set(ownerList);
    const sortParsed = parseHoldingsSortFromJson(data.holdings_sort_by_owner ?? {});
    return NextResponse.json({
      found: true,
      positions: sanitizePositionsForOwners(data.positions, allowed),
      cash_by_owner: sanitizeCashForOwners(data.cash_by_owner, allowed),
      holdings_sort_by_owner: sanitizeHoldingsSortForOwners(sortParsed, allowed),
      sell_log_by_owner: sanitizeSellLogForOwners(data.sell_log_by_owner, allowed),
      owner_names: ownerList,
      target_stock_weight_by_owner: sanitizeTargetStockWeightsForOwners(
        data.target_stock_weight_by_owner,
        allowed,
      ),
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
    let sellLogOut: Record<string, SellLogEntry[]>;
    if ("sellLogByOwner" in b) {
      sellLogOut = sanitizeSellLogForOwners(b.sellLogByOwner, allowed);
    } else {
      const { data: existing } = await admin
        .from("portfolio_snapshots")
        .select("sell_log_by_owner")
        .eq("sync_key", key)
        .maybeSingle();
      sellLogOut = sanitizeSellLogForOwners(existing?.sell_log_by_owner ?? {}, allowed);
    }

    let targetWeightsOut: TargetMap;
    {
      // 클라이언트에서 보낸 값이 있어도, 비어있으면 서버 기존값을 보존합니다.
      // (빈 localStorage를 가진 다른 기기의 auto-push가 서버 목표 비중을 덮어쓰는 버그 방지)
      const incomingRaw =
        "targetStockWeightByOwner" in b && b.targetStockWeightByOwner != null
          ? b.targetStockWeightByOwner
          : null;
      const incomingSanitized = incomingRaw != null
        ? sanitizeTargetStockWeightsForOwners(incomingRaw, allowed)
        : null;
      const incomingIsEmpty =
        incomingSanitized == null || Object.keys(incomingSanitized).length === 0;

      if (!incomingIsEmpty) {
        // 클라이언트에 실제 데이터가 있는 경우: 클라이언트 값 사용
        targetWeightsOut = incomingSanitized!;
      } else {
        // 클라이언트 값이 비어있는 경우: 서버 기존값을 그대로 유지
        const { data: existing } = await admin
          .from("portfolio_snapshots")
          .select("target_stock_weight_by_owner")
          .eq("sync_key", key)
          .maybeSingle();
        targetWeightsOut = sanitizeTargetStockWeightsForOwners(
          existing?.target_stock_weight_by_owner ?? {},
          allowed,
        );
      }
    }

    const updatedAt = new Date().toISOString();
    const payload = {
      sync_key: key,
      positions: positionsOut,
      cash_by_owner: cashOut,
      holdings_sort_by_owner: holdingsSortOut,
      owner_names: ownerNames,
      sell_log_by_owner: sellLogOut,
      target_stock_weight_by_owner: targetWeightsOut,
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
                target_stock_weight_by_owner: targetWeightsOut,
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

  if (action === "pushTargetWeights") {
    const raw = (body as { targetStockWeightByOwner?: unknown }).targetStockWeightByOwner;
    if (raw != null && (typeof raw !== "object" || Array.isArray(raw))) {
      return NextResponse.json(
        { error: "targetStockWeightByOwner 형식이 올바르지 않습니다." },
        { status: 400 },
      );
    }
    const { data: row, error: loadErr } = await admin
      .from("portfolio_snapshots")
      .select("owner_names, target_stock_weight_by_owner")
      .eq("sync_key", key)
      .maybeSingle();
    if (loadErr) {
      return NextResponse.json({ error: friendlyDbError(loadErr.message) }, { status: 500 });
    }
    if (!row) {
      return NextResponse.json(
        {
          error: "서버에 잔고가 없습니다. 먼저 잔고를 『서버로 올리기』한 뒤 다시 시도하세요.",
        },
        { status: 404 },
      );
    }
    const namesFromRow = parseOwnerNames((row as { owner_names?: unknown }).owner_names);
    const allowed = new Set(namesFromRow);
    if (allowed.size === 0 && raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const k of Object.keys(raw as Record<string, unknown>)) {
        if (typeof k === "string" && k.trim()) allowed.add(k);
      }
    }
    const nextSlice = sanitizeTargetStockWeightsForOwners(raw === undefined || raw === null ? {} : raw, allowed);
    const prev = sanitizeTargetStockWeightsForOwners(
      (row as { target_stock_weight_by_owner?: unknown }).target_stock_weight_by_owner ?? {},
      new Set(allowed),
    );
    const merged: TargetMap = { ...prev, ...nextSlice };
    const updatedAt = new Date().toISOString();
    const { error: upErr } = await admin
      .from("portfolio_snapshots")
      .update({ target_stock_weight_by_owner: merged, updated_at: updatedAt })
      .eq("sync_key", key);
    if (upErr) {
      return NextResponse.json({ error: friendlyDbError(upErr.message) }, { status: 500 });
    }
    return NextResponse.json({ ok: true, updated_at: updatedAt });
  }

  return NextResponse.json(
    { error: "action은 pull, push, pushTargetWeights 중 하나여야 합니다." },
    { status: 400 },
  );
}
