import { NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { normalizeStoredSourceTitles } from "@/lib/google-news-rss";

export const dynamic = "force-dynamic";

const NO_STORE = {
  "Cache-Control": "private, no-store, must-revalidate",
} as const;

const emptySources = [] as { title: string; url: string }[];

const THEMES_BRIEF_V2_MARKER = "참고 링크 (위 요약의 [N]과 동일 번호";

export async function GET() {
  const admin = createSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      {
        ok: false,
        error: "Supabase 설정 누락",
        summary: null,
        reportDate: null,
        titles: [] as string[],
        sources: emptySources,
      },
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
        sources: emptySources,
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
        sources: emptySources,
        message: "아직 저장된 AI·방산 뉴스 요약이 없습니다. Cron(macro-themes-briefing)이 실행되면 쌓입니다.",
      },
      { headers: NO_STORE },
    );
  }

  const sources = normalizeStoredSourceTitles(data.source_titles);
  const titles = sources.map((s) => s.title);

  const summary = data.summary ?? null;
  return NextResponse.json(
    {
      ok: true,
      summary,
      reportDate: data.report_date,
      titles,
      sources,
      briefingFormat:
        summary && summary.includes(THEMES_BRIEF_V2_MARKER) ? "headlines-with-links" : "legacy",
    },
    { headers: NO_STORE },
  );
}
