import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

export type AlertRule = {
  owner: string;
  symbol: string;
  minPct?: number;
  maxPct?: number;
};

export type AlertConfigPayload = {
  sync_key: string;
  email: string;
  rules: AlertRule[];
};

export async function GET(req: NextRequest) {
  const syncKey = req.nextUrl.searchParams.get("sync_key");
  if (!syncKey || syncKey.length < 8) {
    return NextResponse.json({ error: "sync_key가 필요합니다." }, { status: 400 });
  }

  const admin = createSupabaseAdmin();
  if (!admin) {
    return NextResponse.json({ error: "Supabase가 설정되지 않았습니다." }, { status: 503 });
  }

  const { data, error } = await admin
    .from("alert_configs")
    .select("email, rules, updated_at")
    .eq("sync_key", syncKey)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ found: false, email: "", rules: [] });

  return NextResponse.json({ found: true, email: data.email, rules: data.rules ?? [] });
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON 파싱 실패" }, { status: 400 });
  }

  const { sync_key, email, rules } = body as Partial<AlertConfigPayload>;

  if (!sync_key || sync_key.length < 8) {
    return NextResponse.json({ error: "sync_key는 8자 이상이어야 합니다." }, { status: 400 });
  }
  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "유효한 이메일을 입력하세요." }, { status: 400 });
  }
  if (!Array.isArray(rules)) {
    return NextResponse.json({ error: "rules가 배열이어야 합니다." }, { status: 400 });
  }

  const admin = createSupabaseAdmin();
  if (!admin) {
    return NextResponse.json({ error: "Supabase가 설정되지 않았습니다." }, { status: 503 });
  }

  const { error } = await admin.from("alert_configs").upsert(
    { sync_key, email, rules, updated_at: new Date().toISOString() },
    { onConflict: "sync_key" },
  );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
