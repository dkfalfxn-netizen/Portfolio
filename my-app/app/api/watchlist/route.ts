import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

const MIN_KEY = 8;

export type WatchlistEntry = { symbol: string; name?: string };

function parseEntries(raw: unknown): WatchlistEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const out: WatchlistEntry[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const sym = typeof o.symbol === "string" ? o.symbol.trim().toUpperCase() : "";
    if (sym.length < 1) continue;
    const name = typeof o.name === "string" ? o.name.trim() : undefined;
    out.push({ symbol: sym, ...(name ? { name } : {}) });
  }
  return out;
}

/** GET /api/watchlist?sync_key= */
export async function GET(req: NextRequest) {
  const syncKey = req.nextUrl.searchParams.get("sync_key") ?? "";
  if (syncKey.length < MIN_KEY) {
    return NextResponse.json({ error: "sync_key가 필요합니다 (8자 이상)." }, { status: 400 });
  }
  const admin = createSupabaseAdmin();
  if (!admin) return NextResponse.json({ error: "Supabase가 설정되지 않았습니다." }, { status: 503 });

  const { data, error } = await admin
    .from("portfolio_snapshots")
    .select("watchlist")
    .eq("sync_key", syncKey)
    .maybeSingle();

  if (error) {
    const msg = error.message ?? "";
    if (msg.includes("watchlist") || msg.includes("column")) {
      return NextResponse.json({
        error: "Supabase에 watchlist 컬럼이 없습니다. supabase/watchlist_column.sql 을 실행하세요.",
        detail: msg,
      }, { status: 500 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
  const entries = parseEntries(data?.watchlist) ?? [];
  return NextResponse.json({ ok: true, entries });
}

/** POST /api/watchlist { sync_key, entries: WatchlistEntry[] } */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON 파싱 실패" }, { status: 400 });
  }
  const b = body as { sync_key?: unknown; entries?: unknown };
  const syncKey = typeof b.sync_key === "string" ? b.sync_key : "";
  if (syncKey.length < MIN_KEY) {
    return NextResponse.json({ error: "sync_key가 필요합니다 (8자 이상)." }, { status: 400 });
  }
  const entries = parseEntries(b.entries);
  if (!entries) {
    return NextResponse.json({ error: "entries는 배열이어야 합니다." }, { status: 400 });
  }

  const admin = createSupabaseAdmin();
  if (!admin) return NextResponse.json({ error: "Supabase가 설정되지 않았습니다." }, { status: 503 });

  const { data: exists } = await admin.from("portfolio_snapshots").select("sync_key").eq("sync_key", syncKey).maybeSingle();
  if (!exists) {
    return NextResponse.json({ error: "먼저 동기화로 portfolio_snapshots에 키를 등록하세요." }, { status: 404 });
  }

  const { error } = await admin
    .from("portfolio_snapshots")
    .update({ watchlist: entries, updated_at: new Date().toISOString() })
    .eq("sync_key", syncKey);

  if (error) {
    const msg = error.message ?? "";
    if (msg.includes("watchlist") || msg.includes("column")) {
      return NextResponse.json({
        error: "Supabase에 watchlist 컬럼이 없습니다. supabase/watchlist_column.sql 을 실행하세요.",
      }, { status: 500 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  return NextResponse.json({ ok: true, entries });
}
