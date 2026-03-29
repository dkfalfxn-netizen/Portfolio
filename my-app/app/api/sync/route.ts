import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

const MIN_KEY_LEN = 8;

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
    return NextResponse.json(
      {
        ok: false,
        supabaseConfigured: true,
        tableError: error.message,
        hint: "Supabase SQL 편집기에서 supabase/portfolio_snapshots.sql을 실행해 테이블을 만드세요.",
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

type PullBody = { action: "pull"; key: string };
type PushBody = {
  action: "push";
  key: string;
  positions: unknown;
  cashByOwner: unknown;
};

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
    const { data, error } = await admin
      .from("portfolio_snapshots")
      .select("positions, cash_by_owner, updated_at")
      .eq("sync_key", key)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!data) {
      return NextResponse.json({
        found: false,
        positions: [],
        cash_by_owner: {},
        updated_at: null,
      });
    }
    return NextResponse.json({
      found: true,
      positions: data.positions ?? [],
      cash_by_owner: data.cash_by_owner ?? {},
      updated_at: data.updated_at,
    });
  }

  if (action === "push") {
    const b = body as PushBody;
    if (!Array.isArray(b.positions) || b.cashByOwner === null || typeof b.cashByOwner !== "object") {
      return NextResponse.json({ error: "positions·cashByOwner 형식이 올바르지 않습니다." }, { status: 400 });
    }

    const { error } = await admin.from("portfolio_snapshots").upsert(
      {
        sync_key: key,
        positions: b.positions,
        cash_by_owner: b.cashByOwner,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "sync_key" },
    );

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "action은 pull 또는 push 여야 합니다." }, { status: 400 });
}
