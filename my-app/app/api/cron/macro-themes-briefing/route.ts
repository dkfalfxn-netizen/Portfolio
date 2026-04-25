import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { generateBriefSummary } from "@/lib/ai-brief-summary";
import { todayKST } from "@/lib/date-utils";
import { coerceNumberedSummaryLines } from "@/lib/briefing-format";
import {
  dedupeHeadlines,
  formatHeadlinesSourceBlock,
  type GoogleNewsHeadline,
  parseGoogleNewsRssHeadlines,
} from "@/lib/google-news-rss";

export const maxDuration = 60;

/** Google 뉴스 RSS (영·한 병행) */
const RSS_QUERIES: { q: string; ceid: "US:en" | "KR:ko" }[] = [
  { q: "artificial intelligence semiconductor investment", ceid: "US:en" },
  { q: "defense industry Korea stock", ceid: "US:en" },
  { q: "인공지능 투자 반도체", ceid: "KR:ko" },
  { q: "방산 한국 주식", ceid: "KR:ko" },
];

const SOURCE_BLOCK_SEP =
  "\n\n────────────────────────\n참고 링크 (위 요약의 [N]과 동일 번호 · Google 뉴스 RSS)\n\n";

function googleNewsRssUrl(q: string, ceid: "US:en" | "KR:ko"): string {
  const encoded = encodeURIComponent(q);
  if (ceid === "KR:ko") {
    return `https://news.google.com/rss/search?q=${encoded}&hl=ko&gl=KR&ceid=KR:ko`;
  }
  return `https://news.google.com/rss/search?q=${encoded}&hl=en&gl=US&ceid=US:en`;
}

function fallbackSummary(items: GoogleNewsHeadline[]): string {
  if (items.length === 0) {
    return "오늘은 RSS에서 가져온 제목이 없어 요약을 만들 수 없습니다. 뉴스 소스·네트워크를 확인하거나, Google 뉴스 검색 결과가 비어 있을 수 있습니다.";
  }
  const head = `최신 헤드라인 ${Math.min(5, items.length)}개를 기준으로 AI·방산 관련 흐름을 짐작할 수 있습니다. Gemini/OpenAI를 쓸 수 없을 때는 아래 목록이 저장됩니다.`;
  return `${head}${SOURCE_BLOCK_SEP}${formatHeadlinesSourceBlock(items.slice(0, 10))}`;
}

async function fetchAllHeadlines(): Promise<GoogleNewsHeadline[]> {
  const all: GoogleNewsHeadline[] = [];
  for (const { q, ceid } of RSS_QUERIES) {
    try {
      const res = await fetch(googleNewsRssUrl(q, ceid), {
        cache: "no-store",
        headers: { "User-Agent": "Mozilla/5.0 (compatible; ThemesBrief/1.0)" },
      });
      if (!res.ok) continue;
      const text = await res.text();
      all.push(...parseGoogleNewsRssHeadlines(text, 18));
    } catch {
      /* next query */
    }
  }
  return dedupeHeadlines(all).slice(0, 40);
}

async function generateSummary(items: GoogleNewsHeadline[], date: string): Promise<string> {
  if (items.length === 0) return fallbackSummary(items);
  const numbered = items
    .map((it, i) => `${i + 1}. ${it.title}\n   URL: ${it.url}`)
    .join("\n\n");
  const text = await generateBriefSummary({
    system:
      "너는 테크·산업 뉴스 데스크다. 입력은 번호가 매겨진 뉴스 **헤드라인**(영·한 혼재)과 각각의 RSS **URL**이다.\n\n" +
      "규칙:\n" +
      "- 투자 권유·단정적 예측 금지.\n" +
      "- 제목에 없는 수치·인용·속보 사실은 쓰지 말 것.\n" +
      "- 한국어로 **정확히 4~6줄**만 출력한다. 각 줄은 **숫자·마침표·공백**으로 시작하고, 끝에 **(근거: [N])** 또는 **(근거: [N][M])**로 근거 헤드라인 번호를 적는다.\n" +
      "- AI·반도체·투자 축과 방산·국방 축이 섞여 있으면 각각 반영한다.\n" +
      "- **URL·도메인·http는 응답에 넣지 마라.**\n" +
      "- 마지막 줄은 **원문 기사 확인이 필요**하다는 취지로 짧게 마무리한다. `(근거: …)`는 생략 가능하다.",
    user: `기준일(한국): ${date}\n\n각 번호는 하나의 뉴스 헤드라인과 그 RSS 링크에 대응한다.\n\n${numbered.slice(0, 12000)}`,
    maxTokens: 950,
    temperature: 0.25,
  });
  if (!text || text.length === 0) {
    return fallbackSummary(items);
  }
  const body = coerceNumberedSummaryLines(text.trim().slice(0, 8000), 6);
  return `${body}${SOURCE_BLOCK_SEP}${formatHeadlinesSourceBlock(items)}`;
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const date = todayKST();
  const items = await fetchAllHeadlines();
  let summary: string;
  try {
    summary = await generateSummary(items, date);
  } catch (err) {
    console.error("[macro-themes-briefing] generateSummary:", err);
    summary = fallbackSummary(items);
  }

  const admin = createSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, error: "Supabase admin 없음", titlesCount: items.length, summary },
      { status: 503 },
    );
  }

  const { error } = await admin.from("macro_themes_briefings").upsert(
    { report_date: date, summary, source_titles: items },
    { onConflict: "report_date" },
  );

  if (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error.message,
        hint: "Supabase에 macro_themes_briefings 테이블이 있는지 확인하세요 (supabase/macro_themes_briefings.sql).",
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, date, titlesCount: items.length, summaryLen: summary.length });
}

export async function POST(req: NextRequest) {
  return GET(req);
}
