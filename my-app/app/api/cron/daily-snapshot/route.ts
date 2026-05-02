import { NextRequest, NextResponse } from "next/server";
import { saveAllSnapshots } from "@/app/api/snapshot/route";

/** Supabase 포트폴리오별 일별 평가 스냅만 저장 (이메일 로직 없음) */
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }
  try {
    const snapshotResult = await saveAllSnapshots();
    return NextResponse.json({ ok: true, snapshotResult });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
