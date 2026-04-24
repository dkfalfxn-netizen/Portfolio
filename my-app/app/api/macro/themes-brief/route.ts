import { NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const NO_STORE = {
  "Cache-Control": "private, no-store, must-revalidate",
} as const;

export async function GET() {
  const admin = createSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, error: "Supabase 설정 누락", summary: null, reportDate: null, titles: [] as string[] },
      { status: 503, headers: NO_STORE },
    );
  }

  const { data, error } = await admin
    .from("macro_themes_briefings")
    .select("report_date, summary, source_titles")
    .order("report_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error.message,
        summary: null,
        reportDate: null,
        titles: [] as string[],
        hint: "테이블이 없으면 supabase/macro_themes_briefings.sql 을 Supabase에 실행하세요.",
      },
      { status: 200, headers: NO_STORE },
    );
  }

  if (!data) {
    return NextResponse.json(
      {
        ok: true,
        summary: null,
        reportDate: null,
        titles: [] as string[],
        message: "아직 저장된 AI·방산 뉴스 요약이 없습니다. Cron(macro-themes-briefing)이 실행되면 쌓입니다.",
      },
      { headers: NO_STORE },
    );
  }

  const titles = Array.isArray(data.source_titles) ? (data.source_titles as string[]) : [];

  return NextResponse.json(
    {
      ok: true,
      summary: data.summary ?? null,
      reportDate: data.report_date,
      titles,
    },
    { headers: NO_STORE },
  );
}
