import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { generateBriefSummary } from "@/lib/ai-brief-summary";
import { todayKST } from "@/lib/date-utils";
import { coerceNumberedSummaryLines, dropIncompleteNumberedLastLine } from "@/lib/briefing-format";
import {
  dedupeHeadlines,
  formatHeadlinesSourceBlock,
  type GoogleNewsHeadline,
  parseGoogleNewsRssHeadlines,
} from "@/lib/google-news-rss";

export const maxDuration = 60;

const RSS_QUERIES = [
  "Federal+Reserve+interest+rate",
  "Kevin+Warsh+Federal+Reserve",
  "FOMC+policy",
] as const;

const SOURCE_BLOCK_SEP =
  "\n\n────────────────────────\n참고 링크 (위 요약의 [N]과 동일 번호 · Google 뉴스 RSS)\n\n";

function googleNewsRssUrl(q: string): string {
  return `https://news.google.com/rss/search?q=${q}&hl=en&gl=US&ceid=US:en`;
}

function fallbackSummary(items: GoogleNewsHeadline[]): string {
  if (items.length === 0) {
    return "오늘은 RSS에서 가져온 제목이 없어 요약을 만들 수 없습니다. 뉴스 소스·네트워크 응답을 확인하세요. 연준·금리 관련 쟁점은 수동 점검이 필요할 수 있습니다. Vercel Cron 로그를 함께 확인해 주세요.";
  }
  const head = `최신 헤드라인 ${Math.min(5, items.length)}개를 기준으로, 연준·금리 정책 논의가 뉴스 흐름에 포함돼 있는지 확인할 수 있습니다. Gemini/OpenAI를 쓸 수 없을 때는 상세 AI 요약 대신 아래 목록이 저장됩니다.`;
  return `${head}${SOURCE_BLOCK_SEP}${formatHeadlinesSourceBlock(items.slice(0, 8))}`;
}

async function fetchAllHeadlines(): Promise<GoogleNewsHeadline[]> {
  const all: GoogleNewsHeadline[] = [];
  for (const q of RSS_QUERIES) {
    try {
      const res = await fetch(googleNewsRssUrl(q), {
        cache: "no-store",
        headers: { "User-Agent": "Mozilla/5.0 (compatible; MacroBrief/1.0)" },
      });
      if (!res.ok) continue;
      const text = await res.text();
      all.push(...parseGoogleNewsRssHeadlines(text, 20));
    } catch {
      /* next query */
    }
  }
  return dedupeHeadlines(all).slice(0, 36);
}

async function generateSummary(items: GoogleNewsHeadline[], date: string): Promise<string> {
  if (items.length === 0) return fallbackSummary(items);
  const numbered = items
    .map((it, i) => `${i + 1}. ${it.title}\n   URL: ${it.url}`)
    .join("\n\n");
  const text = await generateBriefSummary({
    system:
      "너는 국제 금융 뉴스 데스크다. 입력은 번호가 매겨진 뉴스 **헤드라인**과 각각의 RSS **URL**이다(Google 뉴스, 클릭 시 기사로 연결).\n\n" +
      "규칙:\n" +
      "- 투자 권유·단정적 예측 금지.\n" +
      "- 헤드라인에 없는 사실(구체 수치, 인용, 속보)은 쓰지 말 것.\n" +
      "- 한국어로 **정확히 4~6줄**만 출력한다. 각 줄은 반드시 `1. `처럼 **숫자·마침표·공백**으로 시작하고, **짧고 완성된 한 문장**이며, 문장 끝은 `。` `．` `!` `?`로 **반드시** 끝낸다(중간 끊김 금지). 끝에 **(근거: [N])** 또는 **(근거: [N][M])**로 N은 입력 번호와 정확히 일치.\n" +
      "- 뉴스들이 상충하면 한 줄에서 '제목만 보면 상충이 보인다'고 온건하게 쓴다.\n" +
      "- **URL·도메인·http는 응답에 절대 넣지 마라.** 링크는 시스템이 아래에 붙인다.\n" +
      "- 마지막 줄은 **제목만으로는 세부가 없으니, 아래 링크로 기사를 직접 열어 볼 것**이라는 취지로 짧게 마무리한다. `(근거: …)`는 생략 가능. (너는 기사 본문을 보지 못한다. **헤드라인만** 입력이다.)",
    user: `기준일(한국): ${date}\n\n각 번호는 하나의 뉴스 헤드라인과 그 RSS 링크에 대응한다.\n\n${numbered.slice(0, 12000)}`,
    maxTokens: 2048,
    temperature: 0.25,
  });
  if (!text || text.length === 0) {
    return fallbackSummary(items);
  }
  const pre = dropIncompleteNumberedLastLine(text.trim().slice(0, 12_000));
  const body = coerceNumberedSummaryLines(pre, 6);
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
    console.error("[macro-fed-briefing] generateSummary:", err);
    summary = fallbackSummary(items);
  }

  const admin = createSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, error: "Supabase admin 없음", titlesCount: items.length, summary },
      { status: 503 },
    );
  }

  const { error } = await admin.from("macro_fed_briefings").upsert(
    { report_date: date, summary, source_titles: items },
    { onConflict: "report_date" },
  );

  if (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error.message,
        hint: "Supabase에 macro_fed_briefings 테이블이 있는지 확인하세요 (supabase/macro_fed_briefings.sql).",
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, date, titlesCount: items.length, summaryLen: summary.length });
}

export async function POST(req: NextRequest) {
  return GET(req);
}
