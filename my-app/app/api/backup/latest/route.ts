import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

const MIN_KEY_LEN = 8;

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("sync_key")?.trim() ?? "";
  if (!key || key.length < MIN_KEY_LEN) {
    return NextResponse.json(
      { error: `동기화 키(sync_key)는 ${MIN_KEY_LEN}자 이상이어야 합니다.` },
      { status: 400 },
    );
  }

  const admin = createSupabaseAdmin();
  if (!admin) {
    return NextResponse.json({ error: "서버에 Supabase가 설정되지 않았습니다." }, { status: 503 });
  }

  const { data, error } = await admin
    .from("portfolio_snapshot_backups")
    .select("created_at")
    .eq("sync_key", key)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    const hint =
      error.message.includes("relation") || error.message.includes("schema cache")
        ? " Supabase에서 supabase/portfolio_snapshot_backups.sql을 실행해 테이블을 만드세요."
        : "";
    return NextResponse.json({ error: error.message + hint }, { status: 500 });
  }

  const latest =
    data && typeof (data as { created_at?: unknown }).created_at === "string"
      ? (data as { created_at: string }).created_at
      : null;

  return NextResponse.json({
    found: latest != null,
    latest_backup_at: latest,
  });
}
